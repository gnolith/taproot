import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { initializeTaproot } from '../dist/index.js';

const roots = 100_000;
const chunksPerRoot = 10;
const batchSize = 1_000;
const installationId = 'baseline-installation';
const directory = mkdtempSync(
  join(tmpdir(), 'taproot-materialization-baseline-'),
);
const databasePath = join(directory, 'baseline.sqlite');
const db = new NodeSqliteDatabase(databasePath);
const started = performance.now();

try {
  await initializeTaproot(db, { baseIri: 'https://baseline.example' });
  const now = '2026-07-22T00:00:00.000Z';
  await db.batch([
    db
      .prepare(
        `INSERT INTO taproot_search_corpora(
           corpus_id, installation_id, corpus_generation, role, state,
           source_watermark_sequence, fanout_start_sequence,
           enumeration_complete, created_at, activated_at
         ) VALUES ('baseline-corpus', ?, 1, 'active', 'active', ?, ?, 1, ?, ?)`,
      )
      .bind(installationId, roots, roots, now, now),
    db
      .prepare(
        `INSERT INTO taproot_search_installation_state(
           installation_id, active_corpus_id, health_code,
           blocked_producer_count, created_at, updated_at
         ) VALUES (?, 'baseline-corpus', 'blocked-producers', 5, ?, ?)`,
      )
      .bind(installationId, now, now),
  ]);

  for (let offset = 0; offset < roots; offset += batchSize) {
    const rows = Array.from(
      { length: Math.min(batchSize, roots - offset) },
      (_, local) => {
        const ordinal = offset + local + 1;
        const sourceId = `Q${ordinal}`;
        const eventId = `baseline-event-${ordinal}`;
        const stageId = `baseline-stage-${ordinal}`;
        const documentSlot = 'item';
        const documentId = `baseline-document-${ordinal}`;
        return {
          ordinal,
          sourceId,
          eventId,
          stageId,
          documentSlot,
          documentId,
          jobId: `baseline-job-${ordinal}`,
        };
      },
    );
    const chunks = rows.flatMap((row) =>
      Array.from({ length: chunksPerRoot }, (_, chunkOrdinal) => ({
        ...row,
        chunkOrdinal,
        chunkId: `baseline-chunk-${row.ordinal}-${chunkOrdinal}`,
      })),
    );
    const json = JSON.stringify(rows);
    const chunkJson = JSON.stringify(chunks);
    await db.batch([
      db
        .prepare(
          `INSERT INTO taproot_unified_search_source_events(
             event_id, installation_id, domain, source_kind, source_id,
             operation, change_class, source_revision, source_hash,
             authorization_revision, search_generation, payload_hash, created_at
           ) SELECT json_extract(value, '$.eventId'), ?, 'knowledge', 'item',
             json_extract(value, '$.sourceId'), 'upsert', 'canonical', '1',
             ?, 1, json_extract(value, '$.ordinal') + 1, ?, ?
           FROM json_each(?)`,
        )
        .bind(installationId, 'a'.repeat(64), 'b'.repeat(64), now, json),
      db
        .prepare(
          `INSERT INTO taproot_unified_search_source_registry(
             installation_id, source_kind, source_id, domain,
             current_event_id, current_event_sequence, operation,
             change_class, source_revision, source_hash,
             authorization_revision, search_generation, payload_hash, updated_at
           ) SELECT ?, 'item', json_extract(j.value, '$.sourceId'), 'knowledge',
             e.event_id, e.sequence, 'upsert', 'canonical', '1', ?, 1,
             json_extract(j.value, '$.ordinal') + 1, ?, ?
           FROM json_each(?) j JOIN taproot_unified_search_source_events e
             ON e.event_id = json_extract(j.value, '$.eventId')`,
        )
        .bind(installationId, 'a'.repeat(64), 'b'.repeat(64), now, json),
      db
        .prepare(
          `INSERT INTO taproot_search_projection_jobs(
             job_id, corpus_id, installation_id, source_event_id,
             source_event_sequence, source_kind, source_id, operation,
             root_revision, root_hash, authorization_revision,
             search_generation, state, not_before, created_at, updated_at
           ) SELECT json_extract(j.value, '$.jobId'), 'baseline-corpus', ?,
             e.event_id, e.sequence, 'item', e.source_id, 'upsert', '1', ?,
             1, e.search_generation, 'complete', ?, ?, ?
           FROM json_each(?) j JOIN taproot_unified_search_source_events e
             ON e.event_id = json_extract(j.value, '$.eventId')`,
        )
        .bind(installationId, 'a'.repeat(64), now, now, now, json),
      db
        .prepare(
          `INSERT INTO taproot_search_stages(
             stage_id, job_id, corpus_id, claim_token, claim_generation,
             state, root_kind, root_id, source_event_id, source_event_sequence,
             root_revision, root_hash, authorization_revision, manifest_hash,
             page_count, document_count, chunk_count, created_at,
             verified_at, committed_at
           ) SELECT json_extract(j.value, '$.stageId'),
             json_extract(j.value, '$.jobId'), 'baseline-corpus', ?, 1,
             'committed', 'item', e.source_id, e.event_id, e.sequence, '1', ?,
             1, ?, 1, 1, ?, ?, ?, ?
           FROM json_each(?) j JOIN taproot_unified_search_source_events e
             ON e.event_id = json_extract(j.value, '$.eventId')`,
        )
        .bind(
          'c'.repeat(32),
          'a'.repeat(64),
          'd'.repeat(64),
          chunksPerRoot,
          now,
          now,
          now,
          json,
        ),
      db
        .prepare(
          `INSERT INTO taproot_search_staged_documents(
             stage_id, document_slot, document_id, document_hash,
             document_kind, root_reference_json, canonical_reference_json,
             authorization_fingerprint, filter_metadata_json, document_text
           ) SELECT json_extract(value, '$.stageId'), 'item',
             json_extract(value, '$.documentId'), ?, 'item',
             json_object('kind', 'item', 'itemId', json_extract(value, '$.sourceId')),
             json_object('kind', 'item', 'itemId', json_extract(value, '$.sourceId')),
             ?, json_object('languages', json_array('en'),
               'sourceRevisions', json_array('1'), 'byKind', json_object()),
             'baseline text'
           FROM json_each(?)`,
        )
        .bind('e'.repeat(64), 'f'.repeat(64), json),
      db
        .prepare(
          `INSERT INTO taproot_search_chunks(
             stage_id, document_slot, chunk_id, chunk_hash, ordinal,
             document_start, document_end, chunk_text, trace_json
           ) SELECT json_extract(value, '$.stageId'), 'item',
             json_extract(value, '$.chunkId'), ?,
             json_extract(value, '$.chunkOrdinal'), 0, 1, 'x',
             json_array(json_object('field', 'label', 'sourceId',
               json_extract(value, '$.sourceId'), 'language', 'en',
               'documentStart', 0, 'documentEnd', 1,
               'chunkStart', 0, 'chunkEnd', 1))
           FROM json_each(?)`,
        )
        .bind('1'.repeat(64), chunkJson),
      db
        .prepare(
          `INSERT INTO taproot_search_materialization_heads(
             corpus_id, root_kind, root_id, current_stage_id,
             source_event_id, source_event_sequence, root_revision,
             root_hash, authorization_revision, eligible, updated_at
           ) SELECT 'baseline-corpus', 'item', e.source_id,
             json_extract(j.value, '$.stageId'), e.event_id, e.sequence,
             '1', ?, 1, 1, ?
           FROM json_each(?) j JOIN taproot_unified_search_source_events e
             ON e.event_id = json_extract(j.value, '$.eventId')`,
        )
        .bind('a'.repeat(64), now, json),
    ]);
  }

  await db
    .prepare(
      `UPDATE taproot_search_projection_jobs
       SET state = CASE source_event_sequence % 4
         WHEN 0 THEN 'pending'
         WHEN 1 THEN 'leased'
         WHEN 2 THEN 'staged'
         ELSE 'complete' END,
         attempt = CASE WHEN source_event_sequence % 4 IN (1, 2) THEN 1 ELSE 0 END,
         claim_generation = CASE WHEN source_event_sequence % 4 IN (1, 2) THEN 1 ELSE 0 END,
         claim_token = CASE WHEN source_event_sequence % 4 IN (1, 2) THEN ? ELSE NULL END,
         lease_expires_at = CASE WHEN source_event_sequence % 4 IN (1, 2) THEN ? ELSE NULL END,
         not_before = ?`,
    )
    .bind('9'.repeat(32), now, now)
    .run();

  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM taproot_search_materialization_heads) AS roots,
         (SELECT COUNT(*) FROM taproot_search_staged_documents) AS documents,
         (SELECT COUNT(*) FROM taproot_search_chunks) AS chunks`,
    )
    .all();
  const claimWorkload = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN state = 'leased' THEN 1 ELSE 0 END) AS leased,
         SUM(CASE WHEN state = 'staged' THEN 1 ELSE 0 END) AS staged
       FROM taproot_search_projection_jobs WHERE installation_id = ?`,
    )
    .bind(installationId)
    .all();
  const plans = {};
  for (const [name, sql] of Object.entries({
    visible: `SELECT d.document_id FROM taproot_search_materialization_heads h
       JOIN taproot_search_staged_documents d ON d.stage_id = h.current_stage_id
       WHERE h.corpus_id = 'baseline-corpus' AND h.eligible = 1
         AND h.root_kind = 'item' AND h.root_id = 'Q50000'`,
    antiJoin: `SELECT r.source_id FROM taproot_unified_search_source_registry r
       LEFT JOIN taproot_search_materialization_heads h
         ON h.corpus_id = 'baseline-corpus' AND h.root_kind = r.source_kind
        AND h.root_id = r.source_id
       WHERE r.installation_id = '${installationId}'
         AND (h.source_event_sequence IS NULL
           OR h.source_event_sequence != r.current_event_sequence) LIMIT 1`,
    claimPending: `SELECT job_id FROM taproot_search_projection_jobs
       WHERE installation_id = '${installationId}' AND state = 'pending'
         AND not_before <= '${now}'
       ORDER BY not_before, source_event_sequence, corpus_id LIMIT 100`,
    claimExpiredLeased: `SELECT job_id FROM taproot_search_projection_jobs
       WHERE installation_id = '${installationId}'
         AND state = 'leased' AND lease_expires_at <= '${now}'
       ORDER BY lease_expires_at, source_event_sequence, corpus_id LIMIT 100`,
    claimExpiredStaged: `SELECT job_id FROM taproot_search_projection_jobs
       WHERE installation_id = '${installationId}'
         AND state = 'staged' AND lease_expires_at <= '${now}'
       ORDER BY lease_expires_at, source_event_sequence, corpus_id LIMIT 100`,
  })) {
    const result = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
    plans[name] = result.results.map(({ detail }) => detail).join(' | ');
  }
  const artifact = {
    artifactVersion: 1,
    recordedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      sqliteAdapter: '@gnolith/diamond/node-sqlite',
    },
    workload: {
      roots,
      documents: roots,
      chunks: roots * chunksPerRoot,
      claimJobs: claimWorkload.results[0],
    },
    result: {
      ...counts.results[0],
      elapsedMs: Number((performance.now() - started).toFixed(3)),
      databaseBytes: statSync(databasePath).size,
      queryPlans: plans,
    },
    sla: null,
  };
  writeFileSync(
    'benchmarks/search-materialization-100k.json',
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  console.log(JSON.stringify(artifact, null, 2));
} finally {
  await db.close();
  rmSync(directory, { recursive: true, force: true });
}
