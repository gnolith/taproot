import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BaseIriMismatchError,
  InvalidBaseIriError,
  RevisionConflictError,
  SchemaMismatchError,
  TaprootMigrationStateError,
  applyTaprootMigrations,
  initializeTaproot,
  inspectTaprootPersistence,
  inspectTaprootSchema,
  legacyTaprootV1Statements,
  planTaprootMigrations,
  type D1DatabaseLike,
  type SqliteDatabaseLike,
} from '../src/index.js';
import { TaprootRepository } from '../src/repository.js';

const baseIri = 'https://knowledge.example';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('portable Taproot persistence', () => {
  it('preserves D1 compatibility while exposing the neutral capability', () => {
    const acceptsD1 = (candidate: D1DatabaseLike) => candidate;
    const acceptsSqlite = (candidate: SqliteDatabaseLike) => candidate;
    const db = new NodeSqliteDatabase(':memory:');
    expect(acceptsD1(db)).toBe(db);
    expect(acceptsSqlite(db)).toBe(db);
    return db.close();
  });

  it('plans without mutation and requires a durable canonical identity', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    try {
      const plan = await planTaprootMigrations(db);
      expect(plan.map(({ status }) => status)).toEqual([
        'pending',
        'pending',
        'pending',
        'pending',
        'pending',
        'pending',
        'pending',
      ]);
      const tablesBefore = await db
        .prepare(
          `SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'taproot_%'`,
        )
        .all();
      expect(tablesBefore.results).toEqual([]);
      await expect(initializeTaproot(db)).rejects.toBeInstanceOf(
        InvalidBaseIriError,
      );
      await initializeTaproot(db, { baseIri: `${baseIri}///` });
      const inspection = await inspectTaprootPersistence(db);
      expect(inspection).toMatchObject({ baseIri, current: true });
      expect(inspection.migrations.map(({ status }) => status)).toEqual([
        'applied',
        'applied',
        'applied',
        'applied',
        'applied',
        'applied',
        'applied',
      ]);
      await initializeTaproot(db);
      await expect(
        initializeTaproot(db, { baseIri: 'https://other.example' }),
      ).rejects.toBeInstanceOf(BaseIriMismatchError);
    } finally {
      await db.close();
    }
  });

  it('does not report a noncanonical stored identity current', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    try {
      await initializeTaproot(db, { baseIri });
      await db
        .prepare(
          `UPDATE taproot_metadata SET metadata_value = 'HTTPS://Knowledge.Example///'
           WHERE metadata_key = 'base_iri'`,
        )
        .run();
      await expect(inspectTaprootPersistence(db)).resolves.toMatchObject({
        current: false,
      });
      await initializeTaproot(db, { baseIri });
      await expect(inspectTaprootPersistence(db)).resolves.toMatchObject({
        baseIri,
        current: true,
      });
    } finally {
      await db.close();
    }
  });

  it('never lets concurrent first-use identities overwrite each other', async () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'identity-race.sqlite');
    const first = new NodeSqliteDatabase(path, { busyTimeoutMs: 10_000 });
    const second = new NodeSqliteDatabase(path, { busyTimeoutMs: 10_000 });
    const otherIri = 'https://other.example';
    try {
      const outcomes = await Promise.allSettled([
        initializeTaproot(first, { baseIri }),
        initializeTaproot(second, { baseIri: otherIri }),
      ]);
      expect(
        outcomes.filter(({ status }) => status === 'fulfilled'),
      ).toHaveLength(1);
      const stored = await first
        .prepare(
          `SELECT metadata_value FROM taproot_metadata WHERE metadata_key = 'base_iri'`,
        )
        .all<{ metadata_value: string }>();
      const winner = stored.results[0]?.metadata_value;
      expect([baseIri, otherIri]).toContain(winner);
      await expect(
        initializeTaproot(first, {
          baseIri: winner === baseIri ? otherIri : baseIri,
        }),
      ).rejects.toBeInstanceOf(BaseIriMismatchError);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it.each([
    'relative/path',
    'urn:gnolith:test',
    'ftp://knowledge.example',
    'https://user:secret@knowledge.example',
    'https://knowledge.example?identity=other',
    'https://knowledge.example#other',
  ])(
    'rejects invalid first-use identity %s before schema writes',
    async (iri) => {
      const db = new NodeSqliteDatabase(':memory:');
      try {
        await expect(
          applyTaprootMigrations(db, { baseIri: iri }),
        ).rejects.toBeInstanceOf(InvalidBaseIriError);
        const tables = await db
          .prepare(
            `SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'taproot_%'`,
          )
          .all();
        expect(tables.results).toEqual([]);
      } finally {
        await db.close();
      }
    },
  );

  it('persists entities, revisions, identity, and RDF across a file reopen', async () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'taproot.sqlite');
    let db = new NodeSqliteDatabase(path);
    await initializeTaproot(db, { baseIri });
    const repository = new TaprootRepository(db, { baseIri });
    await repository.createProperty({ id: 'P1', datatype: 'string' });
    await repository.createItem({
      id: 'Q1',
      labels: { en: { language: 'en', value: 'persistent' } },
    });
    await db.close();

    db = new NodeSqliteDatabase(path);
    try {
      await initializeTaproot(db);
      const reopened = new TaprootRepository(db, { baseIri });
      expect((await reopened.getEntity('Q1')).entity.labels.en?.value).toBe(
        'persistent',
      );
      const rows = await db
        .prepare(
          `SELECT COUNT(*) AS count FROM rdf_quads WHERE subject_key LIKE ?`,
        )
        .bind('%knowledge.example%Q1%')
        .all<{ count: number }>();
      expect(Number(rows.results[0]?.count)).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });

  it('detects checksum drift without reporting the schema current', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    try {
      await initializeTaproot(db, { baseIri });
      await db
        .prepare(
          `UPDATE _gnolith_migrations SET checksum = 'corrupt'
           WHERE namespace = '@gnolith/taproot' AND migration_id = '0001-v0.1-schema'`,
        )
        .run();
      await expect(planTaprootMigrations(db)).rejects.toBeInstanceOf(
        TaprootMigrationStateError,
      );
      await expect(inspectTaprootPersistence(db)).rejects.toBeInstanceOf(
        TaprootMigrationStateError,
      );
    } finally {
      await db.close();
    }
  });

  it('adopts only an exact current pre-ledger catalog', async () => {
    const exact = new NodeSqliteDatabase(':memory:');
    try {
      await initializeTaproot(exact, { baseIri });
      await exact
        .prepare(
          `DELETE FROM _gnolith_migrations WHERE namespace = '@gnolith/taproot'`,
        )
        .run();
      await exact
        .prepare(
          `UPDATE taproot_metadata SET metadata_value = 'HTTPS://Knowledge.Example///'
           WHERE metadata_key = 'base_iri'`,
        )
        .run();
      expect(await planTaprootMigrations(exact)).toMatchObject([
        { id: '0001-v0.1-schema', status: 'adoptable' },
        { id: '0002-durable-database-identity', status: 'pending' },
        { id: '0003-canonical-statement-text', status: 'pending' },
        { id: '0004-canonical-authorization-policy', status: 'pending' },
        { id: '0005-unified-search-source-events', status: 'pending' },
        {
          id: '0006-unified-search-materialization-lifecycle',
          status: 'pending',
        },
        { id: '0007-external-search-producers', status: 'pending' },
      ]);
      await applyTaprootMigrations(exact, {
        baseIri: 'HTTPS://Knowledge.Example///',
      });
      expect(await inspectTaprootPersistence(exact)).toMatchObject({
        baseIri,
        current: true,
      });
    } finally {
      await exact.close();
    }

    const lookalike = new NodeSqliteDatabase(':memory:');
    try {
      await initializeTaproot(lookalike, { baseIri });
      await lookalike.batch([
        lookalike.prepare(
          `DELETE FROM _gnolith_migrations WHERE namespace = '@gnolith/taproot'`,
        ),
        lookalike.prepare(`DROP INDEX taproot_terms_lookup_idx`),
        lookalike.prepare(
          `CREATE INDEX taproot_terms_lookup_idx ON taproot_terms(entity_id)`,
        ),
      ]);
      expect((await inspectTaprootSchema(lookalike)).valid).toBe(true);
      await expect(planTaprootMigrations(lookalike)).rejects.toBeInstanceOf(
        TaprootMigrationStateError,
      );
    } finally {
      await lookalike.close();
    }
  });

  it('refuses to stamp a version-one lookalike catalog', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    try {
      await db.batch(
        legacyTaprootV1Statements.map((statement) => db.prepare(statement)),
      );
      await db.batch([
        db.prepare(`DROP INDEX taproot_terms_lookup_idx`),
        db.prepare(
          `CREATE INDEX taproot_terms_lookup_idx ON taproot_terms(entity_id)`,
        ),
      ]);
      await expect(initializeTaproot(db, { baseIri })).rejects.toBeInstanceOf(
        SchemaMismatchError,
      );
      const ledger = await db
        .prepare(
          `SELECT COUNT(*) AS count FROM _gnolith_migrations
           WHERE namespace = '@gnolith/taproot'`,
        )
        .all<{ count: number }>();
      expect(Number(ledger.results[0]?.count)).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('rejects cross-connection statements and rolls back late write failures', async () => {
    const first = new NodeSqliteDatabase(':memory:');
    const second = new NodeSqliteDatabase(':memory:');
    try {
      await expect(first.batch([second.prepare('SELECT 1')])).rejects.toThrow(
        /connection|adapter|statement/iu,
      );
      await initializeTaproot(first, { baseIri });
      const repository = new TaprootRepository(first, {
        baseIri,
        createId: () => 'duplicate-event',
      });
      await repository.createProperty({ id: 'P1', datatype: 'string' });
      await expect(repository.createItem({ id: 'Q1' })).rejects.toBeInstanceOf(
        RevisionConflictError,
      );
      const counts = await first
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM taproot_entities WHERE entity_id = 'Q1') AS entities,
            (SELECT COUNT(*) FROM taproot_entity_revisions WHERE entity_id = 'Q1') AS revisions,
            (SELECT COUNT(*) FROM taproot_audit_events WHERE entity_id = 'Q1') AS audits,
            (SELECT COUNT(*) FROM taproot_terms WHERE entity_id = 'Q1') AS terms,
            (SELECT COUNT(*) FROM taproot_rdf_ownership WHERE entity_id = 'Q1') AS ownership`,
        )
        .all<{
          entities: number;
          revisions: number;
          audits: number;
          terms: number;
          ownership: number;
        }>();
      expect(counts.results[0]).toEqual({
        entities: 0,
        revisions: 0,
        audits: 0,
        terms: 0,
        ownership: 0,
      });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('serializes two connections racing on one file with one revision winner', async () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'race.sqlite');
    const first = new NodeSqliteDatabase(path, { busyTimeoutMs: 10_000 });
    const second = new NodeSqliteDatabase(path, { busyTimeoutMs: 10_000 });
    try {
      await Promise.all([
        initializeTaproot(first, { baseIri }),
        initializeTaproot(second, { baseIri }),
      ]);
      const initial = await new TaprootRepository(first, {
        baseIri,
      }).createItem({
        id: 'Q1',
      });
      const outcomes = await Promise.allSettled([
        new TaprootRepository(first, { baseIri }).setLabel(
          'Q1',
          'en',
          'first',
          { expectedRevision: initial.newRevision },
        ),
        new TaprootRepository(second, { baseIri }).setLabel(
          'Q1',
          'en',
          'second',
          { expectedRevision: initial.newRevision },
        ),
      ]);
      expect(
        outcomes.filter(({ status }) => status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        outcomes.filter(({ status }) => status === 'rejected'),
      ).toHaveLength(1);
      const stored = await new TaprootRepository(first, { baseIri }).getEntity(
        'Q1',
      );
      expect(stored.entity.lastrevid).toBe(2);
      const orphanCounts = await first
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM taproot_entity_revisions WHERE entity_id = 'Q1') AS revisions,
            (SELECT COUNT(*) FROM taproot_audit_events WHERE entity_id = 'Q1') AS audits`,
        )
        .all<{ revisions: number; audits: number }>();
      expect(orphanCounts.results[0]).toEqual({ revisions: 2, audits: 2 });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'taproot-persistence-'));
  temporaryDirectories.push(directory);
  return directory;
}
