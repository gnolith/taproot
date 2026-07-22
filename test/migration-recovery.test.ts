import { encodeTerm } from '@gnolith/diamond';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { Miniflare } from 'miniflare';
import { DataFactory } from 'rdf-data-factory';
import { describe, expect, it } from 'vitest';
import {
  initializeTaproot,
  inspectTaprootPersistence,
  legacyTaprootV1Statements,
  type SqliteDatabaseLike,
  type SqlitePreparedStatementLike,
  type SqliteResultLike,
} from '../src/index.js';

const baseIri = 'https://knowledge.example';
const interrupted = new Error('simulated process interruption');

type RecoveryBoundary =
  'structure' | 'revision-row' | 'revisions' | 'audit' | 'rdf-row' | 'rdf';

class TrackedStatement implements SqlitePreparedStatementLike {
  constructor(
    readonly sql: string,
    readonly inner: SqlitePreparedStatementLike,
  ) {}

  bind(...values: unknown[]): TrackedStatement {
    return new TrackedStatement(this.sql, this.inner.bind(...values));
  }

  run<T = Record<string, unknown>>(): Promise<SqliteResultLike<T>> {
    return this.inner.run<T>();
  }

  all<T = Record<string, unknown>>(): Promise<SqliteResultLike<T>> {
    return this.inner.all<T>();
  }
}

class InterruptingDatabase implements SqliteDatabaseLike {
  private didInterrupt = false;

  constructor(
    private readonly inner: SqliteDatabaseLike,
    private readonly boundary: RecoveryBoundary | 'inside-structure',
  ) {}

  prepare(sql: string): TrackedStatement {
    return new TrackedStatement(sql, this.inner.prepare(sql));
  }

  async batch<T = Record<string, unknown>>(
    statements: SqlitePreparedStatementLike[],
  ): Promise<Array<SqliteResultLike<T>>> {
    const tracked = statements.map((statement) => {
      if (!(statement instanceof TrackedStatement)) {
        throw new Error('Test adapter received an untracked statement');
      }
      return statement;
    });
    const structural = tracked.some((statement) =>
      /ALTER TABLE taproot_entity_revisions RENAME/iu.test(statement.sql),
    );
    if (
      !this.didInterrupt &&
      this.boundary === 'inside-structure' &&
      structural
    ) {
      this.didInterrupt = true;
      const middle = Math.max(1, Math.floor(tracked.length / 2));
      const broken = this.inner.prepare(
        `INSERT INTO taproot_assertions(no_such_column) VALUES ('fail')`,
      );
      const injected = [
        ...tracked.slice(0, middle).map(({ inner }) => inner),
        broken,
        ...tracked.slice(middle).map(({ inner }) => inner),
      ];
      return this.inner.batch<T>(injected);
    }

    const results = await this.inner.batch<T>(
      tracked.map(({ inner }) => inner),
    );
    if (!this.didInterrupt && (await this.reachedBoundary())) {
      this.didInterrupt = true;
      throw interrupted;
    }
    return results;
  }

  private async reachedBoundary(): Promise<boolean> {
    if (this.boundary === 'inside-structure') return false;
    const phase = await metadata(this.inner, 'migration_phase');
    const completedRevisions = await scalar(
      this.inner,
      `SELECT COUNT(*) AS count FROM taproot_entity_revisions
       WHERE event_id IS NOT NULL AND content_hash IS NOT NULL`,
    );
    const ownership = await scalar(
      this.inner,
      `SELECT COUNT(*) AS count FROM taproot_rdf_ownership`,
    );
    switch (this.boundary) {
      case 'structure':
        return phase === 'structure' && completedRevisions === 0;
      case 'revision-row':
        return phase === 'structure' && completedRevisions === 1;
      case 'revisions':
        return phase === 'revisions';
      case 'audit':
        return phase === 'audit' && ownership === 0;
      case 'rdf-row':
        return phase === 'audit' && ownership > 0;
      case 'rdf':
        return phase === 'rdf';
    }
  }
}

describe('legacy migration interruption recovery', () => {
  it('rolls back the complete structural upgrade when a statement fails', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    try {
      await seedLegacy(db);
      await expect(
        initializeTaproot(new InterruptingDatabase(db, 'inside-structure'), {
          baseIri,
        }),
      ).rejects.toThrow();

      expect(await metadata(db, 'migration_phase')).toBeUndefined();
      expect(await hasColumn(db, 'taproot_entity_revisions', 'event_id')).toBe(
        false,
      );
      expect(await taprootLedgerCount(db)).toBe(0);

      await initializeTaproot(db, { baseIri });
      await expectCurrentRecoveredState(db);
    } finally {
      await db.close();
    }
  });

  it.each<RecoveryBoundary>([
    'structure',
    'revision-row',
    'revisions',
    'audit',
    'rdf-row',
    'rdf',
  ])('resumes after a committed %s boundary', async (boundary) => {
    const db = new NodeSqliteDatabase(':memory:');
    try {
      await seedLegacy(db);
      await expect(
        initializeTaproot(new InterruptingDatabase(db, boundary), { baseIri }),
      ).rejects.toBe(interrupted);

      expect(await taprootLedgerCount(db)).toBe(0);
      await expect(inspectTaprootPersistence(db)).resolves.toMatchObject({
        current: false,
      });

      await initializeTaproot(db, { baseIri });
      await expectCurrentRecoveredState(db);
    } finally {
      await db.close();
    }
  });

  it('fails closed when the durable source base marker is corrupted', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    try {
      await seedLegacy(db);
      await expect(
        initializeTaproot(new InterruptingDatabase(db, 'structure'), {
          baseIri,
        }),
      ).rejects.toBe(interrupted);
      await db
        .prepare(
          `UPDATE taproot_metadata SET metadata_value = 'https://other.example'
           WHERE metadata_key = 'migration_source_base_iri'`,
        )
        .run();

      await expect(initializeTaproot(db, { baseIri })).rejects.toThrow(
        /source base IRI/iu,
      );
      expect(await taprootLedgerCount(db)).toBe(0);
      expect(await metadata(db, 'migration_phase')).toBe('structure');
    } finally {
      await db.close();
    }
  });

  it('repairs a prematurely stamped database left by an older initializer', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    try {
      await seedLegacy(db);
      await initializeTaproot(db, { baseIri });
      await db.batch([db.prepare(`DELETE FROM taproot_rdf_ownership`)]);

      expect(await taprootLedgerCount(db)).toBe(7);
      await expect(inspectTaprootPersistence(db)).resolves.toMatchObject({
        current: false,
      });

      await initializeTaproot(db, { baseIri });
      await expectCurrentRecoveredState(db);
    } finally {
      await db.close();
    }
  });

  it('repairs missing Diamond quads without trusting intact ownership rows', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    try {
      await seedLegacy(db);
      await initializeTaproot(db, { baseIri });
      const ownershipBefore = await scalar(
        db,
        `SELECT COUNT(*) AS count FROM taproot_rdf_ownership`,
      );
      expect(ownershipBefore).toBeGreaterThan(0);
      await insertUnrelatedQuad(db);
      await db.batch([
        db.prepare(
          `DELETE FROM rdf_quads
           WHERE EXISTS (
             SELECT 1 FROM taproot_rdf_ownership o
             WHERE o.subject_key = rdf_quads.subject_key
               AND o.predicate_key = rdf_quads.predicate_key
               AND o.object_key = rdf_quads.object_key
               AND o.graph_key = rdf_quads.graph_key
           )`,
        ),
      ]);

      expect(await taprootLedgerCount(db)).toBe(7);
      expect(
        await scalar(db, `SELECT COUNT(*) AS count FROM taproot_rdf_ownership`),
      ).toBe(ownershipBefore);
      await expect(inspectTaprootPersistence(db)).resolves.toMatchObject({
        current: false,
      });

      await initializeTaproot(db, { baseIri });
      await expectCurrentRecoveredState(db);
      expect(await scalar(db, `SELECT COUNT(*) AS count FROM rdf_quads`)).toBe(
        ownershipBefore + 1,
      );
    } finally {
      await db.close();
    }
  });

  it('removes old lexical RDF when adopting an equivalent canonical identity', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    const oldLexicalBase = 'HTTPS://Knowledge.Example';
    try {
      await seedLegacy(db);
      await initializeTaproot(db, { baseIri });
      const ownershipBefore = await scalar(
        db,
        `SELECT COUNT(*) AS count FROM taproot_rdf_ownership`,
      );
      const quadReplacements = Array.from(
        { length: 8 },
        () => [baseIri, oldLexicalBase] as const,
      ).flat();
      const ownershipReplacements = Array.from(
        { length: 4 },
        () => [baseIri, oldLexicalBase] as const,
      ).flat();
      await db.batch([
        db
          .prepare(`DELETE FROM _gnolith_migrations WHERE namespace = ?`)
          .bind('@gnolith/taproot'),
        db
          .prepare(
            `UPDATE taproot_metadata SET metadata_value = ?
             WHERE metadata_key = 'base_iri'`,
          )
          .bind(`${oldLexicalBase}///`),
        db
          .prepare(
            `UPDATE rdf_quads SET
             subject_key = replace(subject_key, ?, ?),
             subject_json = replace(subject_json, ?, ?),
             predicate_key = replace(predicate_key, ?, ?),
             predicate_json = replace(predicate_json, ?, ?),
             object_key = replace(object_key, ?, ?),
             object_json = replace(object_json, ?, ?),
             graph_key = replace(graph_key, ?, ?),
             graph_json = replace(graph_json, ?, ?)`,
          )
          .bind(...quadReplacements),
        db
          .prepare(
            `UPDATE taproot_rdf_ownership SET
             subject_key = replace(subject_key, ?, ?),
             predicate_key = replace(predicate_key, ?, ?),
             object_key = replace(object_key, ?, ?),
             graph_key = replace(graph_key, ?, ?)`,
          )
          .bind(...ownershipReplacements),
      ]);

      await expect(
        initializeTaproot(new InterruptingDatabase(db, 'revisions'), {
          baseIri,
        }),
      ).rejects.toBe(interrupted);
      expect(await metadata(db, 'migration_source_base_iri')).toBe(
        `${oldLexicalBase}///`,
      );
      await initializeTaproot(db, { baseIri });
      await expectCurrentRecoveredState(db);
      expect(
        await scalar(
          db,
          `SELECT COUNT(*) AS count FROM rdf_quads
           WHERE instr(subject_key, 'Knowledge.Example') > 0
              OR instr(predicate_key, 'Knowledge.Example') > 0
              OR instr(object_key, 'Knowledge.Example') > 0
              OR instr(graph_key, 'Knowledge.Example') > 0`,
        ),
      ).toBe(0);
      expect(await scalar(db, `SELECT COUNT(*) AS count FROM rdf_quads`)).toBe(
        ownershipBefore,
      );
    } finally {
      await db.close();
    }
  });

  it('refuses to stamp conflicting audit contents', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    try {
      await seedLegacy(db);
      await expect(
        initializeTaproot(new InterruptingDatabase(db, 'audit'), { baseIri }),
      ).rejects.toBe(interrupted);
      await db
        .prepare(
          `UPDATE taproot_audit_events SET edit_summary = 'conflict'
           WHERE event_id = 'legacy-Q1-1'`,
        )
        .run();

      await expect(initializeTaproot(db, { baseIri })).rejects.toThrow(
        /audit|identity/iu,
      );
      expect(await taprootLedgerCount(db)).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('refuses to stamp conflicting package migration seeds', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    try {
      await seedLegacy(db);
      await expect(
        initializeTaproot(new InterruptingDatabase(db, 'rdf'), { baseIri }),
      ).rejects.toBe(interrupted);
      await db
        .prepare(
          `INSERT INTO taproot_migrations(version, name)
           VALUES (1, 'conflict')`,
        )
        .run();

      await expect(initializeTaproot(db, { baseIri })).rejects.toThrow();
      expect(await taprootLedgerCount(db)).toBe(0);
      expect(await metadata(db, 'migration_phase')).toBe('rdf');
    } finally {
      await db.close();
    }
  });

  it('resumes a committed per-row backfill through a D1-compatible adapter', async () => {
    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-07-19',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: crypto.randomUUID() },
    });
    try {
      const db = (await miniflare.getD1Database(
        'DB',
      )) as unknown as SqliteDatabaseLike;
      await seedLegacy(db);
      await expect(
        initializeTaproot(new InterruptingDatabase(db, 'revision-row'), {
          baseIri,
        }),
      ).rejects.toBe(interrupted);
      expect(await taprootLedgerCount(db)).toBe(0);

      await initializeTaproot(db, { baseIri });
      await expectCurrentRecoveredState(db);
    } finally {
      await miniflare.dispose();
    }
  }, 30_000);
});

async function seedLegacy(db: SqliteDatabaseLike): Promise<void> {
  await db.batch(
    legacyTaprootV1Statements.map((statement) => db.prepare(statement)),
  );
  const entities = ['Q1', 'Q2'].map((id) =>
    JSON.stringify({
      id,
      type: 'item',
      labels: {},
      descriptions: {},
      aliases: {},
      claims: {},
      sitelinks: {},
      lastrevid: 1,
      modified: '2026-01-01T00:00:00.000Z',
    }),
  );
  await db.batch([
    db.prepare(
      `INSERT INTO taproot_metadata(metadata_key, metadata_value)
       VALUES ('base_iri', 'HTTPS://Knowledge.Example///')`,
    ),
    ...entities.flatMap((entity, index) => {
      const id = `Q${index + 1}`;
      return [
        db
          .prepare(
            `INSERT INTO taproot_entities(
               entity_id, entity_type, revision, entity_json, modified_at
             ) VALUES (?, 'item', 1, ?, '2026-01-01T00:00:00.000Z')`,
          )
          .bind(id, entity),
        db
          .prepare(
            `INSERT INTO taproot_entity_revisions(
               entity_id, revision, entity_json, actor
             ) VALUES (?, 1, ?, 'legacy-user')`,
          )
          .bind(id, entity),
      ];
    }),
  ]);
}

async function insertUnrelatedQuad(db: SqliteDatabaseLike): Promise<void> {
  const factory = new DataFactory();
  const encoded = [
    factory.namedNode('https://unrelated.example/subject'),
    factory.namedNode('https://unrelated.example/predicate'),
    factory.literal('unrelated'),
    factory.defaultGraph(),
  ].map((term) => encodeTerm(term));
  await db
    .prepare(
      `INSERT INTO rdf_quads(
         subject_key, subject_json, predicate_key, predicate_json,
         object_key, object_json, graph_key, graph_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(...encoded.flatMap(({ key, json }) => [key, json]))
    .run();
}

async function expectCurrentRecoveredState(
  db: SqliteDatabaseLike,
): Promise<void> {
  await expect(inspectTaprootPersistence(db)).resolves.toMatchObject({
    baseIri,
    current: true,
  });
  expect(await metadata(db, 'migration_phase')).toBeUndefined();
  expect(await metadata(db, 'migration_source')).toBeUndefined();
  expect(await metadata(db, 'migration_source_rdf_version')).toBeUndefined();
  expect(await metadata(db, 'migration_source_base_iri')).toBeUndefined();
  expect(await taprootLedgerCount(db)).toBe(7);
  expect(
    await scalar(
      db,
      `SELECT COUNT(*) AS count FROM taproot_entity_revisions
       WHERE event_id IS NULL OR content_hash IS NULL`,
    ),
  ).toBe(0);
  expect(
    await scalar(db, `SELECT COUNT(*) AS count FROM taproot_audit_events`),
  ).toBe(2);
  expect(
    await scalar(db, `SELECT COUNT(*) AS count FROM taproot_rdf_ownership`),
  ).toBeGreaterThan(0);
  expect(
    await scalar(
      db,
      `SELECT COUNT(*) AS count FROM taproot_migrations
       WHERE (version = 1 AND name = 'initial')
           OR (version = 2 AND name = 'audit-and-operations')
           OR (version = 3 AND name = 'canonical-statement-text')
           OR (version = 4 AND name = 'canonical-authorization-policy')
           OR (version = 5 AND name = 'unified-search-source-events')
           OR (version = 6 AND name = 'unified-search-materialization-lifecycle')
           OR (version = 7 AND name = 'external-search-producers')`,
    ),
  ).toBe(7);
}

async function metadata(
  db: SqliteDatabaseLike,
  key: string,
): Promise<string | undefined> {
  try {
    const result = await db
      .prepare(
        `SELECT metadata_value FROM taproot_metadata WHERE metadata_key = ?`,
      )
      .bind(key)
      .all<{ metadata_value: string }>();
    return result.results[0]?.metadata_value;
  } catch {
    return undefined;
  }
}

async function scalar(db: SqliteDatabaseLike, sql: string): Promise<number> {
  try {
    const result = await db.prepare(sql).all<{ count: number }>();
    return Number(result.results[0]?.count ?? 0);
  } catch {
    return 0;
  }
}

async function hasColumn(
  db: SqliteDatabaseLike,
  table: string,
  column: string,
): Promise<boolean> {
  const result = await db
    .prepare(`SELECT name FROM pragma_table_info(?) WHERE name = ?`)
    .bind(table, column)
    .all<{ name: string }>();
  return result.results.length > 0;
}

async function taprootLedgerCount(db: SqliteDatabaseLike): Promise<number> {
  return scalar(
    db,
    `SELECT COUNT(*) AS count FROM _gnolith_migrations
     WHERE namespace = '@gnolith/taproot'`,
  );
}
