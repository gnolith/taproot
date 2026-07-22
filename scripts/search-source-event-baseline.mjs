import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { initializeTaproot } from '../dist/index.js';

const requested = Number(process.argv[2] ?? 100_000);
if (!Number.isSafeInteger(requested) || requested < 1 || requested > 100_000) {
  throw new Error('event count must be an integer from 1 through 100000');
}

const directory = mkdtempSync(join(tmpdir(), 'taproot-source-baseline-'));
const databasePath = join(directory, 'baseline.sqlite');
const db = new NodeSqliteDatabase(databasePath);
try {
  await initializeTaproot(db, { baseIri: 'https://baseline.example' });
  const started = performance.now();
  const statementCountPerSource = 2;
  const sourcesPerBatch = 50;
  for (let offset = 0; offset < requested; offset += sourcesPerBatch) {
    const statements = [];
    for (
      let index = offset;
      index < Math.min(requested, offset + sourcesPerBatch);
      index += 1
    ) {
      const sourceId = `task-${index}`;
      const eventId = `baseline-${index}`;
      const digest = index.toString(16).padStart(64, '0');
      statements.push(
        db
          .prepare(
            `INSERT INTO taproot_unified_search_source_events(
               event_id, installation_id, domain, source_kind, source_id,
               operation, change_class, source_revision, source_hash,
               authorization_revision, search_generation, predecessor_event_id,
               predecessor_sequence, payload_hash, created_at
             ) VALUES (?, 'baseline-installation', 'tasks', 'task', ?,
               'upsert', 'canonical', '1', ?, 1, ?, NULL, NULL, ?,
               '2026-07-22T00:00:00.000Z')`,
          )
          .bind(eventId, sourceId, digest, index + 1, digest),
        db
          .prepare(
            `INSERT INTO taproot_unified_search_source_registry(
               installation_id, source_kind, source_id, domain, current_event_id,
               current_event_sequence, operation, change_class, source_revision,
               source_hash, authorization_revision, search_generation, payload_hash, updated_at
             ) SELECT 'baseline-installation', 'task', ?, 'tasks', event_id,
               sequence, operation, change_class, source_revision, source_hash,
               authorization_revision, search_generation, payload_hash, created_at
               FROM taproot_unified_search_source_events WHERE event_id = ?`,
          )
          .bind(sourceId, eventId),
      );
    }
    if (statements.length > sourcesPerBatch * statementCountPerSource)
      throw new Error(
        'baseline statement cardinality exceeded its constant bound',
      );
    await db.batch(statements);
  }
  const elapsedMs = performance.now() - started;
  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM taproot_unified_search_source_events) AS events,
         (SELECT COUNT(*) FROM taproot_unified_search_source_registry) AS registry`,
    )
    .all();
  const plan = await db
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT event_id, payload_hash FROM taproot_unified_search_source_events
       WHERE installation_id = 'baseline-installation'
         AND source_kind = 'task' AND source_id = 'task-99999'
         AND source_revision = '1'`,
    )
    .all();
  const row = counts.results[0];
  if (Number(row?.events) !== requested || Number(row?.registry) !== requested)
    throw new Error('baseline cardinality mismatch');
  const detail = plan.results.map(({ detail }) => detail).join(' ');
  if (!detail.includes('INDEX'))
    throw new Error('baseline replay lookup is not indexed');
  console.log(
    JSON.stringify(
      {
        artifactVersion: 1,
        recordedAt: new Date().toISOString(),
        runtime: {
          node: process.version,
          sqliteAdapter: '@gnolith/diamond/node-sqlite',
        },
        workload: {
          sourceEvents: requested,
          sourceKinds: ['task'],
          sourcesPerBatch,
          statementsPerSource: statementCountPerSource,
          payloadShape: 'metadata-only-v1',
        },
        result: {
          events: Number(row.events),
          registry: Number(row.registry),
          elapsedMs: Number(elapsedMs.toFixed(3)),
          eventsPerSecond: Number(((requested / elapsedMs) * 1000).toFixed(3)),
          databaseBytes: statSync(databasePath).size,
          replayLookupPlan: detail,
        },
        sla: null,
      },
      null,
      2,
    ),
  );
} finally {
  await db.close();
  rmSync(directory, { recursive: true, force: true });
}
