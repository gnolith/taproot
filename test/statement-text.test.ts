import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { describe, expect, it } from 'vitest';
import {
  InvalidStatementError,
  TaprootMigrationStateError,
  TaprootRepository,
  applyTaprootMigrations,
  createStatement,
  initializeTaproot,
  type EntityCommand,
  type Statement,
} from '../src/index.js';

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
});

async function downgradeStatementTextMigration(
  db: NodeSqliteDatabase,
): Promise<void> {
  await db.batch([
    db.prepare(
      `DELETE FROM _gnolith_migrations
       WHERE namespace = '@gnolith/taproot'
         AND migration_id = '0003-canonical-statement-text'`,
    ),
    db.prepare(`DELETE FROM taproot_migrations WHERE version = 3`),
    db.prepare(
      `UPDATE taproot_metadata SET metadata_value = '1'
       WHERE metadata_key = 'canonical_json_version'`,
    ),
  ]);
}
