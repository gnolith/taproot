import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { createSqliteVectorIndexV1, initializeTaproot } from '../dist/index.js';

const records = Number(process.env.TAPROOT_BASELINE_RECORDS ?? 1000);
const dimensions = Number(process.env.TAPROOT_BASELINE_DIMENSIONS ?? 32);
if (!Number.isSafeInteger(records) || records < 1 || records > 100_000)
  throw new Error('TAPROOT_BASELINE_RECORDS is invalid');
if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 4096)
  throw new Error('TAPROOT_BASELINE_DIMENSIONS is invalid');

const directory = mkdtempSync(join(tmpdir(), 'taproot-hybrid-baseline-'));
const path = join(directory, 'taproot.sqlite');
const db = new NodeSqliteDatabase(path);
try {
  await initializeTaproot(db, { baseIri: 'https://baseline.example' });
  const adapter = createSqliteVectorIndexV1(db);
  const corpus = Array.from({ length: records }, (_, index) => {
    const vector = Array.from(
      { length: dimensions },
      (__, ordinal) => (((index + 1) * (ordinal + 3)) % 97) / 97,
    );
    return {
      id: `baseline-${index.toString().padStart(8, '0')}`,
      installationId: 'baseline-installation',
      configurationId: 'baseline-configuration',
      generation: 1,
      kind: 'item',
      sourceId: `Q${index + 1}`,
      sourceRevision: '1',
      documentId: `document-${index}`,
      chunkId: null,
      contentHash: index.toString(16).padStart(64, '0'),
      authorization: { version: 1, clauses: [] },
      selector: null,
      vector,
    };
  });
  const estimatedTokens = corpus.reduce(
    (sum, record) => sum + Math.ceil(record.sourceId.length / 4),
    0,
  );
  const beforeMemory = process.memoryUsage().rss;
  const indexStart = performance.now();
  for (let index = 0; index < corpus.length; index += 100)
    await adapter.upsert(
      corpus.slice(index, index + 100),
      dimensions,
      'cosine',
    );
  const indexMs = performance.now() - indexStart;
  const queryStart = performance.now();
  const result = await adapter.query(
    {
      installationId: 'baseline-installation',
      configurationId: 'baseline-configuration',
      generation: 1,
      kinds: ['item'],
      vector: corpus[0].vector,
      limit: 20,
      context: {
        installationId: 'baseline-installation',
        principalId: 'baseline',
        activeWorkspaceId: null,
        workspaceIds: [],
        capabilities: [],
        authorizationRevision: 1,
      },
    },
    dimensions,
    'cosine',
  );
  const queryMs = performance.now() - queryStart;
  await db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run();
  console.log(
    JSON.stringify({
      runtime: process.version,
      records,
      dimensions,
      estimatedTokens,
      batches: Math.ceil(records / 100),
      indexMs: Number(indexMs.toFixed(3)),
      queryMs: Number(queryMs.toFixed(3)),
      storageBytes: statSync(path).size,
      rssDeltaBytes: process.memoryUsage().rss - beforeMemory,
      returned: result.length,
      thresholds: null,
    }),
  );
} finally {
  await db.close();
  rmSync(directory, { recursive: true, force: true });
}
