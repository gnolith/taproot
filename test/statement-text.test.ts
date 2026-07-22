import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { describe, expect, it } from 'vitest';
import {
  InvalidStatementError,
  PERSISTED_STATEMENT_TEXT_PAGE_SIZE,
  SchemaMismatchError,
  TaprootMigrationStateError,
  applyTaprootMigrations,
  createStatement,
  initializeTaproot,
  legacyTaprootV1Statements,
  taprootAuthorizationSchemaStatements,
  taprootSearchSourceEventSchemaStatements,
  taprootSearchMaterializationSchemaStatements,
  taprootExternalSearchProducerSchemaStatements,
  taprootCompleteSearchSchemaStatements,
  type EntityCommand,
  type SqliteDatabaseLike,
  type SqlitePreparedStatementLike,
  type SqliteResultLike,
  type Statement,
} from '../src/index.js';
import { TaprootRepository } from '../src/repository.js';

const baseIri = 'https://statement-text.example';

function authoredStatement(text: string): Statement {
  return {
    id: 'Q1$authored',
    type: 'statement',
    text,
    rank: 'normal',
    mainsnak: {
      snaktype: 'value',
      property: 'P1',
      datatype: 'string',
      datavalue: { type: 'string', value: 'kiln firing' },
    },
    qualifiers: {},
    'qualifiers-order': [],
    references: [],
  };
}

describe('authored statement text on native SQLite', () => {
  it('rejects absent or blank create and update text without carrying stale text', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    try {
      await initializeTaproot(db, { baseIri });
      const repository = new TaprootRepository(db, { baseIri });
      await repository.createProperty({ id: 'P1', datatype: 'string' });
      const item = await repository.createItem({ id: 'Q1' });

      for (const text of [undefined, '', ' \t\n']) {
        const candidate = authoredStatement('temporary') as unknown as Record<
          string,
          unknown
        >;
        if (text === undefined) delete candidate.text;
        else candidate.text = text;
        await expect(
          repository.addStatement('Q1', candidate as unknown as Statement, {
            expectedRevision: item.newRevision,
          }),
        ).rejects.toBeInstanceOf(InvalidStatementError);
      }
      expect((await repository.getEntity('Q1')).entity.lastrevid).toBe(1);
      expect(() =>
        createStatement(
          'Q1',
          {
            snaktype: 'somevalue',
            property: 'P1',
            datatype: 'string',
          },
          '   ',
        ),
      ).toThrow(InvalidStatementError);

      const added = await repository.addStatement(
        'Q1',
        authoredStatement('Kiln firing is the subject of this statement.'),
        { expectedRevision: 1 },
      );
      const stale = added.entity.claims.P1?.[0]?.text;
      await expect(
        repository.setStatementRank(
          'Q1',
          'Q1$authored',
          'preferred',
          undefined as never,
          { expectedRevision: 2 },
        ),
      ).rejects.toBeInstanceOf(InvalidStatementError);
      for (const text of ['', '   ']) {
        await expect(
          repository.setStatementRank('Q1', 'Q1$authored', 'preferred', text, {
            expectedRevision: 2,
          }),
        ).rejects.toBeInstanceOf(InvalidStatementError);
      }
      expect((await repository.getEntity('Q1')).entity.lastrevid).toBe(2);

      const deliberatelyReused = await repository.setStatementRank(
        'Q1',
        'Q1$authored',
        'preferred',
        stale as string,
        { expectedRevision: 2 },
      );
      expect(deliberatelyReused.entity.claims.P1?.[0]?.text).toBe(stale);
      expect(
        (await repository.getEntityRevision('Q1', 2)).entity.claims.P1?.[0]
          ?.rank,
      ).toBe('normal');

      const reauthored = await repository.applyCommands(
        'Q1',
        [
          {
            type: 'set-statement-rank',
            statementId: 'Q1$authored',
            rank: 'preferred',
            text: 'Kiln firing remains preferred after review.',
          },
        ],
        { expectedRevision: 3 },
      );
      expect(reauthored.contentHash).not.toBe(deliberatelyReused.contentHash);
      expect(reauthored.entity.claims.P1?.[0]?.text).toBe(
        'Kiln firing remains preferred after review.',
      );

      const omittedCommand = {
        type: 'set-statement-rank',
        statementId: 'Q1$authored',
        rank: 'normal',
      } as EntityCommand;
      await expect(
        repository.applyCommands('Q1', [omittedCommand], {
          expectedRevision: 4,
        }),
      ).rejects.toBeInstanceOf(InvalidStatementError);

      await expect(
        repository.applyCommands(
          'Q1',
          [
            {
              type: 'set-statement-rank',
              statementId: 'Q1$authored',
              rank: 'normal',
              text: '\u00a0',
            },
            { type: 'remove-statement', statementId: 'Q1$authored' },
          ],
          { expectedRevision: 4 },
        ),
      ).rejects.toBeInstanceOf(InvalidStatementError);
      expect((await repository.getEntity('Q1')).entity.claims.P1).toHaveLength(
        1,
      );

      await expect(
        repository.replaceEntity('Q1', structuredClone(reauthored.entity), {
          expectedRevision: 4,
          statementTexts: {},
        }),
      ).rejects.toBeInstanceOf(InvalidStatementError);

      await expect(
        repository.revertEntity('Q1', 2, {
          expectedRevision: 4,
          statementTexts: {},
        }),
      ).rejects.toBeInstanceOf(InvalidStatementError);
      const reverted = await repository.revertEntity('Q1', 2, {
        expectedRevision: 4,
        statementTexts: {
          Q1$authored: 'Kiln firing restored from the reviewed revision.',
        },
      });
      expect(reverted.entity.claims.P1?.[0]?.text).toBe(
        'Kiln firing restored from the reviewed revision.',
      );

      const exported = await repository.exportEntities();
      const restoredDb = new NodeSqliteDatabase(':memory:');
      try {
        await initializeTaproot(restoredDb, { baseIri: `${baseIri}/restore` });
        const restored = new TaprootRepository(restoredDb, {
          baseIri: `${baseIri}/restore`,
        });
        const entities = exported
          .trim()
          .split('\n')
          .map(
            (line) =>
              JSON.parse(line) as Parameters<typeof restored.importEntity>[0],
          );
        expect((await restored.importEntities(entities)).failed).toEqual([]);
        expect(
          (await restored.getEntity('Q1')).entity.claims.P1?.[0]?.text,
        ).toBe('Kiln firing restored from the reviewed revision.');
      } finally {
        await restoredDb.close();
      }
    } finally {
      await db.close();
    }
  });

  it('upgrades empty legacy JSON state but fails closed on unauthored persisted statements', async () => {
    const clean = new NodeSqliteDatabase(':memory:');
    try {
      await initializeTaproot(clean, { baseIri });
      await downgradeStatementTextMigration(clean);
      await expect(applyTaprootMigrations(clean)).resolves.toMatchObject({
        current: true,
      });
    } finally {
      await clean.close();
    }

    const legacy = new NodeSqliteDatabase(':memory:');
    try {
      await initializeTaproot(legacy, { baseIri });
      await downgradeStatementTextMigration(legacy);
      const json = JSON.stringify({
        id: 'Q1',
        type: 'item',
        labels: {},
        descriptions: {},
        aliases: {},
        claims: {
          P1: [
            {
              id: 'Q1$legacy',
              type: 'statement',
              rank: 'normal',
              mainsnak: {
                snaktype: 'somevalue',
                property: 'P1',
                datatype: 'string',
              },
              qualifiers: {},
              'qualifiers-order': [],
              references: [],
            },
          ],
        },
        sitelinks: {},
        lastrevid: 1,
        modified: '2026-01-01T00:00:00.000Z',
      });
      await legacy.batch([
        legacy
          .prepare(
            `INSERT INTO taproot_entities(entity_id, entity_type, datatype, revision, entity_json, modified_at)
             VALUES ('Q1', 'item', NULL, 1, ?, '2026-01-01T00:00:00.000Z')`,
          )
          .bind(json),
        legacy
          .prepare(
            `INSERT INTO taproot_entity_revisions(
               entity_id, revision, entity_json, tags_json, event_id,
               content_hash, created_at
             ) VALUES ('Q1', 1, ?, '[]', 'legacy-event', 'legacy-hash',
               '2026-01-01T00:00:00.000Z')`,
          )
          .bind(json),
      ]);
      await expect(applyTaprootMigrations(legacy)).rejects.toBeInstanceOf(
        TaprootMigrationStateError,
      );
      const version = await legacy
        .prepare(
          `SELECT metadata_value FROM taproot_metadata WHERE metadata_key = 'canonical_json_version'`,
        )
        .all<{ metadata_value: string }>();
      expect(version.results[0]?.metadata_value).toBe('1');
    } finally {
      await legacy.close();
    }
  });

  it.each(['\t\n', '\u00a0'])(
    'rejects historical-only %j whitespace with runtime-equivalent migration semantics',
    async (text) => {
      const db = new NodeSqliteDatabase(':memory:');
      try {
        await initializeTaproot(db, { baseIri });
        await downgradeStatementTextMigration(db);
        await insertCurrentAndHistorical(db, text);
        await expect(applyTaprootMigrations(db)).rejects.toBeInstanceOf(
          TaprootMigrationStateError,
        );
        const version = await db
          .prepare(
            `SELECT metadata_value FROM taproot_metadata WHERE metadata_key = 'canonical_json_version'`,
          )
          .all<{ metadata_value: string }>();
        expect(version.results[0]?.metadata_value).toBe('1');
      } finally {
        await db.close();
      }
    },
  );

  it('gates legacy recovery before stamping canonical v2 when only history lacks text', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    try {
      await db.batch(
        legacyTaprootV1Statements.map((statement) => db.prepare(statement)),
      );
      const current = entityJson(2);
      const historical = entityJson(1, '\u00a0');
      await db.batch([
        db
          .prepare(
            `INSERT INTO taproot_entities(entity_id, entity_type, datatype, revision, entity_json, modified_at)
             VALUES ('Q1', 'item', NULL, 2, ?, '2026-01-02T00:00:00.000Z')`,
          )
          .bind(current),
        db
          .prepare(
            `INSERT INTO taproot_entity_revisions(entity_id, revision, entity_json, actor, edit_summary)
             VALUES ('Q1', 1, ?, NULL, NULL), ('Q1', 2, ?, NULL, NULL)`,
          )
          .bind(historical, current),
      ]);
      await expect(
        applyTaprootMigrations(db, { baseIri }),
      ).rejects.toBeInstanceOf(SchemaMismatchError);
      const ledger = await db
        .prepare(
          `SELECT COUNT(*) AS count FROM _gnolith_migrations
           WHERE namespace = '@gnolith/taproot'`,
        )
        .all<{ count: number }>();
      expect(Number(ledger.results[0]?.count ?? 0)).toBe(0);
    } finally {
      await db.close();
    }
  });

  it.each(['current', 'historical'] as const)(
    'uses bounded keyset pages and rejects a later-page %s violation',
    async (source) => {
      const db = new NodeSqliteDatabase(':memory:');
      try {
        await initializeTaproot(db, { baseIri });
        await downgradeStatementTextMigration(db);
        await insertPagedCorpus(db, source);
        const tracked = new PageTrackingDatabase(db);
        await expect(applyTaprootMigrations(tracked)).rejects.toBeInstanceOf(
          TaprootMigrationStateError,
        );
        expect(
          tracked.pageSizes.every(
            (size) => size <= PERSISTED_STATEMENT_TEXT_PAGE_SIZE,
          ),
        ).toBe(true);
        expect(tracked.pageSizes).toContain(PERSISTED_STATEMENT_TEXT_PAGE_SIZE);
        expect(tracked.pageSizes.at(-1)).toBe(1);
        const state = await db
          .prepare(
            `SELECT
               (SELECT metadata_value FROM taproot_metadata
                WHERE metadata_key = 'canonical_json_version') AS json_version,
               (SELECT COUNT(*) FROM _gnolith_migrations
                WHERE namespace = '@gnolith/taproot') AS ledger_count`,
          )
          .all<{ json_version: string; ledger_count: number }>();
        expect(state.results[0]).toMatchObject({
          json_version: '1',
          ledger_count: 2,
        });
      } finally {
        await db.close();
      }
    },
  );

  it('migrates a valid corpus spanning multiple bounded current and history pages', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    try {
      await initializeTaproot(db, { baseIri });
      const repository = new TaprootRepository(db, { baseIri });
      for (
        let index = 0;
        index <= PERSISTED_STATEMENT_TEXT_PAGE_SIZE;
        index += 1
      )
        await repository.createItem();
      await downgradeStatementTextMigration(db);
      const tracked = new PageTrackingDatabase(db);
      await expect(applyTaprootMigrations(tracked)).resolves.toMatchObject({
        current: true,
      });
      expect(tracked.pageSizes).toEqual([
        PERSISTED_STATEMENT_TEXT_PAGE_SIZE,
        1,
        PERSISTED_STATEMENT_TEXT_PAGE_SIZE,
        1,
      ]);
    } finally {
      await db.close();
    }
  });
});

async function downgradeStatementTextMigration(
  db: SqliteDatabaseLike,
): Promise<void> {
  await dropAuthorizationSchema(db);
  await db.batch([
    db.prepare(
      `DELETE FROM _gnolith_migrations
       WHERE namespace = '@gnolith/taproot'
         AND migration_id IN (
           '0003-canonical-statement-text',
           '0004-canonical-authorization-policy',
           '0005-unified-search-source-events',
           '0006-unified-search-materialization-lifecycle',
           '0007-external-search-producers'
           ,'0008-complete-search-content-semantic'
         )`,
    ),
    db.prepare(`DELETE FROM taproot_migrations WHERE version >= 3`),
    db.prepare(
      `UPDATE taproot_metadata SET metadata_value = '1'
       WHERE metadata_key = 'canonical_json_version'`,
    ),
  ]);
}

async function dropAuthorizationSchema(db: SqliteDatabaseLike): Promise<void> {
  const objects = [
    ...taprootAuthorizationSchemaStatements,
    ...taprootSearchSourceEventSchemaStatements,
    ...taprootSearchMaterializationSchemaStatements,
    ...taprootExternalSearchProducerSchemaStatements,
    ...taprootCompleteSearchSchemaStatements,
  ]
    .map((sql) =>
      /^CREATE (?:UNIQUE )?(TABLE|INDEX|TRIGGER) (?:IF NOT EXISTS )?([a-z0-9_]+)/iu.exec(
        sql,
      ),
    )
    .filter((match): match is RegExpExecArray => match !== null)
    .reverse();
  await db.batch(
    objects.map((match) =>
      db.prepare(`DROP ${match[1]!.toUpperCase()} IF EXISTS ${match[2]}`),
    ),
  );
}

async function insertPagedCorpus(
  db: SqliteDatabaseLike,
  source: 'current' | 'historical',
): Promise<void> {
  const page = PERSISTED_STATEMENT_TEXT_PAGE_SIZE;
  if (source === 'current') {
    await db.batch(
      Array.from({ length: page + 1 }, (_, index) => {
        const id = `Q${String(index + 1).padStart(4, '0')}`;
        const json = pagedEntityJson(
          id,
          1,
          index === page ? '\u00a0' : undefined,
        );
        return db
          .prepare(
            `INSERT INTO taproot_entities(
               entity_id, entity_type, datatype, revision, entity_json, modified_at
             ) VALUES (?, 'item', NULL, 1, ?, '2026-01-01T00:00:00.000Z')`,
          )
          .bind(id, json);
      }),
    );
    return;
  }
  const id = 'Q1';
  const current = pagedEntityJson(id, page + 1);
  await db
    .prepare(
      `INSERT INTO taproot_entities(
         entity_id, entity_type, datatype, revision, entity_json, modified_at
       ) VALUES (?, 'item', NULL, ?, ?, '2026-01-01T00:00:00.000Z')`,
    )
    .bind(id, page + 1, current)
    .run();
  await db.batch(
    Array.from({ length: page + 1 }, (_, index) => {
      const revision = index + 1;
      const json = pagedEntityJson(
        id,
        revision,
        index === page ? '\u00a0' : undefined,
      );
      return db
        .prepare(
          `INSERT INTO taproot_entity_revisions(
             entity_id, revision, entity_json, tags_json, event_id,
             content_hash, created_at
           ) VALUES (?, ?, ?, '[]', ?, ?, '2026-01-01T00:00:00.000Z')`,
        )
        .bind(id, revision, json, `event-${revision}`, `hash-${revision}`);
    }),
  );
}

function pagedEntityJson(
  id: string,
  revision: number,
  statementText?: string,
): string {
  return JSON.stringify({
    id,
    type: 'item',
    labels: {},
    descriptions: {},
    aliases: {},
    claims:
      statementText === undefined
        ? {}
        : {
            P1: [
              {
                id: `${id}$later-page`,
                type: 'statement',
                text: statementText,
              },
            ],
          },
    sitelinks: {},
    lastrevid: revision,
    modified: '2026-01-01T00:00:00.000Z',
  });
}

class PageTrackingStatement implements SqlitePreparedStatementLike {
  constructor(
    readonly sql: string,
    readonly inner: SqlitePreparedStatementLike,
    private readonly recordPage: (size: number) => void,
  ) {}

  bind(...values: unknown[]): PageTrackingStatement {
    return new PageTrackingStatement(
      this.sql,
      this.inner.bind(...values),
      this.recordPage,
    );
  }

  run<T = Record<string, unknown>>(): Promise<SqliteResultLike<T>> {
    return this.inner.run<T>();
  }

  async all<T = Record<string, unknown>>(): Promise<SqliteResultLike<T>> {
    const result = await this.inner.all<T>();
    if (this.sql.includes('taproot:statement-text-'))
      this.recordPage(result.results.length);
    return result;
  }
}

class PageTrackingDatabase implements SqliteDatabaseLike {
  readonly pageSizes: number[] = [];

  constructor(private readonly inner: SqliteDatabaseLike) {}

  prepare(sql: string): PageTrackingStatement {
    return new PageTrackingStatement(sql, this.inner.prepare(sql), (size) =>
      this.pageSizes.push(size),
    );
  }

  batch<T = Record<string, unknown>>(
    statements: SqlitePreparedStatementLike[],
  ): Promise<Array<SqliteResultLike<T>>> {
    return this.inner.batch<T>(
      statements.map((statement) => {
        if (!(statement instanceof PageTrackingStatement))
          throw new Error('Expected a page-tracked statement');
        return statement.inner;
      }),
    );
  }
}

async function insertCurrentAndHistorical(
  db: NodeSqliteDatabase,
  historicalText: string,
): Promise<void> {
  const current = entityJson(2);
  const historical = entityJson(1, historicalText);
  await db.batch([
    db
      .prepare(
        `INSERT INTO taproot_entities(entity_id, entity_type, datatype, revision, entity_json, modified_at)
         VALUES ('Q1', 'item', NULL, 2, ?, '2026-01-02T00:00:00.000Z')`,
      )
      .bind(current),
    db
      .prepare(
        `INSERT INTO taproot_entity_revisions(
           entity_id, revision, entity_json, tags_json, event_id,
           content_hash, created_at
         ) VALUES ('Q1', 1, ?, '[]', 'historical-event', 'historical-hash',
           '2026-01-01T00:00:00.000Z'),
           ('Q1', 2, ?, '[]', 'current-event', 'current-hash',
           '2026-01-02T00:00:00.000Z')`,
      )
      .bind(historical, current),
  ]);
}

function entityJson(revision: number, statementText?: string): string {
  return JSON.stringify({
    id: 'Q1',
    type: 'item',
    labels: {},
    descriptions: {},
    aliases: {},
    claims:
      statementText === undefined
        ? {}
        : {
            P1: [
              {
                id: 'Q1$historical',
                type: 'statement',
                text: statementText,
                rank: 'normal',
                mainsnak: {
                  snaktype: 'somevalue',
                  property: 'P1',
                  datatype: 'string',
                },
                qualifiers: {},
                'qualifiers-order': [],
                references: [],
              },
            ],
          },
    sitelinks: {},
    lastrevid: revision,
    modified: `2026-01-0${revision}T00:00:00.000Z`,
  });
}
