import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyNamespacedMigrations,
  migrateDiamondStore,
  type D1DatabaseLike,
} from '@gnolith/diamond';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyTaprootMigrations,
  inspectTaprootSchema,
  planTaprootMigrations,
} from '../src/index.js';
import {
  taprootMigrations,
  taprootMigrationNamespace,
} from '../src/migrations.js';

const options = { baseIri: 'https://external-migration.example' };
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

for (const runtime of [nodeRuntime(), workerdRuntime()]) {
  describe(`external producer migration on ${runtime.name}`, () => {
    it('preserves the complete 0006 staged graph and accepts exactly seven kinds across restart', async () => {
      const first = await runtime.create();
      let firstClosed = false;
      try {
        await createExact0006(first.db);
        await seed0006Graph(first.db);
        expect(await planTaprootMigrations(first.db)).toMatchObject([
          { id: '0001-v0.1-schema', status: 'applied' },
          { id: '0002-durable-database-identity', status: 'applied' },
          { id: '0003-canonical-statement-text', status: 'applied' },
          { id: '0004-canonical-authorization-policy', status: 'applied' },
          { id: '0005-unified-search-source-events', status: 'applied' },
          {
            id: '0006-unified-search-materialization-lifecycle',
            status: 'applied',
          },
          { id: '0007-external-search-producers', status: 'pending' },
          {
            id: '0008-complete-search-content-semantic',
            status: 'pending',
          },
        ]);

        await applyTaprootMigrations(first.db, options);
        expect((await inspectTaprootSchema(first.db)).valid).toBe(true);
        await expectPreservedGraph(first.db);
        await expectExactlySevenKinds(first.db);

        await first.close();
        firstClosed = true;
        const second = await first.reopen();
        try {
          expect((await inspectTaprootSchema(second.db)).valid).toBe(true);
          await expectPreservedGraph(second.db);
          expect(
            await scalar(
              second.db,
              `SELECT COUNT(*) FROM taproot_search_staged_documents`,
            ),
          ).toBe(7);
        } finally {
          await second.close();
        }
      } finally {
        if (!firstClosed) await first.close();
      }
    }, 30_000);
  });
}

async function createExact0006(db: D1DatabaseLike): Promise<void> {
  await migrateDiamondStore(db);
  await applyNamespacedMigrations(
    db,
    taprootMigrationNamespace,
    taprootMigrations.slice(0, 6),
  );
  await db
    .prepare(
      `INSERT INTO taproot_metadata(metadata_key, metadata_value)
       VALUES ('base_iri', ?)`,
    )
    .bind(options.baseIri)
    .run();
}

async function seed0006Graph(db: D1DatabaseLike): Promise<void> {
  const now = '2026-07-22T00:00:00.000Z';
  await db.batch([
    db
      .prepare(
        `INSERT INTO taproot_unified_search_source_events(
         event_id, installation_id, domain, source_kind, source_id, operation,
         change_class, source_revision, source_hash, authorization_revision,
         search_generation, predecessor_event_id, predecessor_sequence,
         payload_hash, created_at
       ) VALUES ('event-1', 'installation-1', 'taproot', 'item', 'Q1', 'upsert',
                 'canonical', '1', 'root-hash', 1, 1, NULL, NULL, 'payload-hash', ?)`,
      )
      .bind(now),
    db
      .prepare(
        `INSERT INTO taproot_search_corpora(
         corpus_id, installation_id, corpus_generation, role, state,
         source_watermark_sequence, fanout_start_sequence, enumeration_complete,
         created_at
       ) VALUES ('corpus-1', 'installation-1', 1, 'active', 'active', 1, 1, 1, ?)`,
      )
      .bind(now),
  ]);
  await db.batch([
    db
      .prepare(
        `INSERT INTO taproot_search_projection_jobs(
         job_id, corpus_id, installation_id, source_event_id,
         source_event_sequence, source_kind, source_id, operation,
         root_revision, root_hash, authorization_revision, search_generation,
         state, attempt, claim_generation, not_before, created_at, updated_at
       ) VALUES ('job-1', 'corpus-1', 'installation-1', 'event-1', 1, 'item',
                 'Q1', 'upsert', '1', 'root-hash', 1, 1, 'complete', 1, 1, ?, ?, ?)`,
      )
      .bind(now, now, now),
    db
      .prepare(
        `INSERT INTO taproot_search_stages(
         stage_id, job_id, corpus_id, claim_token, claim_generation, state,
         root_kind, root_id, source_event_id, source_event_sequence,
         root_revision, root_hash, authorization_revision, manifest_hash,
         page_count, document_count, chunk_count, created_at, verified_at,
         committed_at
       ) VALUES ('stage-1', 'job-1', 'corpus-1', 'historical-claim', 1,
                 'committed', 'item', 'Q1', 'event-1', 1, '1', 'root-hash', 1,
                 'manifest-hash', 1, 1, 1, ?, ?, ?)`,
      )
      .bind(now, now, now),
  ]);
  await db.batch([
    db.prepare(
      `INSERT INTO taproot_search_staged_documents(
         stage_id, document_slot, document_id, document_hash, document_kind,
         root_reference_json, canonical_reference_json,
         authorization_fingerprint, filter_metadata_json, document_text
       ) VALUES ('stage-1', 'slot-item', 'document-item', 'document-hash', 'item',
                 '{"kind":"item","id":"Q1"}', '{"kind":"item","id":"Q1"}',
                 'authorization-hash', '{"source_revision":["1"]}', 'preserved text')`,
    ),
    db.prepare(
      `INSERT INTO taproot_search_document_clauses
         (stage_id, document_slot, clause_ordinal)
       VALUES ('stage-1', 'slot-item', 0)`,
    ),
    db.prepare(
      `INSERT INTO taproot_search_document_atoms(
         stage_id, document_slot, clause_ordinal, atom_ordinal, atom_kind, atom_value)
       VALUES ('stage-1', 'slot-item', 0, 0, 'public', NULL)`,
    ),
    db.prepare(
      `INSERT INTO taproot_search_filter_values(
         stage_id, document_slot, filter_name, filter_value)
       VALUES ('stage-1', 'slot-item', 'source_revision', '1')`,
    ),
    db.prepare(
      `INSERT INTO taproot_search_chunks(
         stage_id, document_slot, chunk_id, chunk_hash, ordinal,
         document_start, document_end, chunk_text, trace_json)
       VALUES ('stage-1', 'slot-item', 'chunk-1', 'chunk-hash', 0,
               0, 14, 'preserved text', '{"version":1}')`,
    ),
  ]);
}

async function expectPreservedGraph(db: D1DatabaseLike): Promise<void> {
  expect(
    await row(
      db,
      `SELECT document_id, document_hash, document_kind, document_text
       FROM taproot_search_staged_documents WHERE document_slot = 'slot-item'`,
    ),
  ).toEqual({
    document_id: 'document-item',
    document_hash: 'document-hash',
    document_kind: 'item',
    document_text: 'preserved text',
  });
  expect(
    await scalar(db, `SELECT COUNT(*) FROM taproot_search_document_clauses`),
  ).toBe(1);
  expect(
    await scalar(db, `SELECT COUNT(*) FROM taproot_search_document_atoms`),
  ).toBe(1);
  expect(
    await scalar(db, `SELECT COUNT(*) FROM taproot_search_filter_values`),
  ).toBe(1);
  expect(await scalar(db, `SELECT COUNT(*) FROM taproot_search_chunks`)).toBe(
    1,
  );
}

async function expectExactlySevenKinds(db: D1DatabaseLike): Promise<void> {
  const kinds = [
    'statement',
    'task',
    'memory',
    'prompt',
    'resource',
    'annotation',
  ] as const;
  for (const kind of kinds)
    await db
      .prepare(
        `INSERT INTO taproot_search_staged_documents(
           stage_id, document_slot, document_id, document_hash, document_kind,
           root_reference_json, canonical_reference_json,
           authorization_fingerprint, filter_metadata_json, document_text
         ) VALUES ('stage-1', ?, ?, ?, ?, '{}', '{}', 'auth', '{}', ?)`,
      )
      .bind(`slot-${kind}`, `document-${kind}`, `hash-${kind}`, kind, kind)
      .run();
  await expect(
    db
      .prepare(
        `INSERT INTO taproot_search_staged_documents(
           stage_id, document_slot, document_id, document_hash, document_kind,
           root_reference_json, canonical_reference_json,
           authorization_fingerprint, filter_metadata_json, document_text
         ) VALUES ('stage-1', 'slot-other', 'document-other', 'hash-other',
                   'other', '{}', '{}', 'auth', '{}', 'other')`,
      )
      .run(),
  ).rejects.toThrow();
}

function nodeRuntime() {
  return {
    name: 'persisted Node SQLite',
    create() {
      const directory = mkdtempSync(join(tmpdir(), 'taproot-migration-node-'));
      temporaryDirectories.push(directory);
      const path = join(directory, 'taproot.sqlite');
      const db = new NodeSqliteDatabase(path);
      return {
        db,
        close: () => db.close(),
        reopen() {
          const reopened = new NodeSqliteDatabase(path);
          return { db: reopened, close: () => reopened.close() };
        },
      };
    },
  };
}

function workerdRuntime() {
  return {
    name: 'persisted Workerd D1',
    async create() {
      const directory = mkdtempSync(join(tmpdir(), 'taproot-migration-d1-'));
      temporaryDirectories.push(directory);
      const databaseId = crypto.randomUUID();
      const createMiniflare = () =>
        new Miniflare({
          modules: true,
          script: 'export default { fetch() { return new Response("ok") } }',
          compatibilityDate: '2026-07-19',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: { DB: databaseId },
          d1Persist: directory,
        });
      const miniflare = createMiniflare();
      const db = (await miniflare.getD1Database(
        'DB',
      )) as unknown as D1DatabaseLike;
      return {
        db,
        close: () => miniflare.dispose(),
        async reopen() {
          const reopenedMiniflare = createMiniflare();
          const reopened = (await reopenedMiniflare.getD1Database(
            'DB',
          )) as unknown as D1DatabaseLike;
          return { db: reopened, close: () => reopenedMiniflare.dispose() };
        },
      };
    },
  };
}

async function scalar(db: D1DatabaseLike, sql: string): Promise<number> {
  const result = await db.prepare(sql).all<Record<string, unknown>>();
  return Number(Object.values(result.results[0] ?? {})[0] ?? 0);
}

async function row(
  db: D1DatabaseLike,
  sql: string,
): Promise<Record<string, unknown> | undefined> {
  return (await db.prepare(sql).all<Record<string, unknown>>()).results[0];
}
