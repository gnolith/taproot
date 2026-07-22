import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createQdrantVectorIndexV1 } from '../dist/index.js';

const IMAGE = 'qdrant/qdrant:v1.15.4';
const name = `taproot-qdrant-${process.pid}`;
const port = await availablePort();

const docker = spawnSync('docker', ['--version'], { encoding: 'utf8' });
if (docker.status !== 0)
  throw new Error('Docker is required for Qdrant conformance');

try {
  await command('docker', [
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--publish',
    `${port}:6333`,
    IMAGE,
  ]);
  const endpoint = `http://127.0.0.1:${port}`;
  await waitUntilReady(endpoint);
  const collection = 'taproot_conformance';
  const created = await globalThis.fetch(
    `${endpoint}/collections/${collection}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vectors: { size: 3, distance: 'Cosine' } }),
    },
  );
  if (!created.ok)
    throw new Error(`Qdrant collection creation failed: ${created.status}`);
  const adapter = createQdrantVectorIndexV1({
    endpoint,
    collection,
    allowPrivateEndpoint: true,
  });
  await adapter.validate(3, 'cosine');
  await adapter.upsert(
    [
      record('document-a', 'installation-a', [1, 0, 0]),
      record('document-private', 'installation-a', [0.99, 0.01, 0], {
        version: 1,
        clauses: [[{ kind: 'principal', principalId: 'other' }]],
      }),
      record('document-b', 'installation-b', [1, 0, 0]),
    ],
    3,
    'cosine',
  );
  const result = await adapter.query(
    {
      installationId: 'installation-a',
      configurationId: 'configuration-a',
      generation: 1,
      kinds: ['item'],
      vector: [1, 0, 0],
      limit: 10,
      context: context('installation-a'),
    },
    3,
    'cosine',
  );
  assert(
    JSON.stringify(result.map(({ derivedId }) => derivedId)) ===
      JSON.stringify(['document-a']),
    'Qdrant authorization/isolation query failed',
  );
  await adapter.delete({
    installationId: 'installation-a',
    configurationId: 'configuration-a',
    ids: ['document-a'],
  });
  const afterDelete = await adapter.query(
    {
      installationId: 'installation-a',
      configurationId: 'configuration-a',
      generation: 1,
      kinds: ['item'],
      vector: [1, 0, 0],
      limit: 10,
      context: context('installation-a'),
    },
    3,
    'cosine',
  );
  assert(afterDelete.length === 0, 'Qdrant delete failed');
  console.log(
    JSON.stringify({
      image: IMAGE,
      dimensions: 3,
      metric: 'cosine',
      lifecycle: 'validate/upsert/authorized-query/isolation/delete',
      passed: true,
    }),
  );
} finally {
  spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
}

function record(
  id,
  installationId,
  vector,
  authorization = { version: 1, clauses: [] },
) {
  return {
    id,
    installationId,
    configurationId: 'configuration-a',
    generation: 1,
    kind: 'item',
    sourceId: `source-${id}`,
    sourceRevision: '1',
    documentId: id,
    chunkId: null,
    contentHash: 'a'.repeat(64),
    authorization,
    selector: null,
    vector,
  };
}

function context(installationId) {
  return {
    installationId,
    principalId: 'principal-1',
    activeWorkspaceId: null,
    workspaceIds: [],
    capabilities: [],
    authorizationRevision: 1,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitUntilReady(endpoint) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await globalThis.fetch(`${endpoint}/readyz`);
      if (response.ok) return;
    } catch {
      // Container is still starting.
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
  }
  throw new Error('Qdrant did not become ready');
}

function command(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`${executable} failed (${code}): ${stderr.slice(0, 1000)}`),
        );
    });
  });
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to allocate Qdrant port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
