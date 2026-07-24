import { spawn, spawnSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import {
  commitAuthorizationBootstrapV1,
  createTaprootHostWriteCapability,
  createTaprootWorkshopPortV1,
  initializeTaproot,
  KNOWLEDGE_POLICY_CAPABILITY,
  KNOWLEDGE_WRITE_CAPABILITY,
  prepareAuthorizationBootstrapV1,
  registerAuthorizationBootstrapOwnerV1,
} from '../dist/index.js';
import { createQdrantVectorIndexV1 } from '../dist/adapters-qdrant.js';
import {
  createSearchMaterializationAdminGuardV1,
  createSemanticSearchAdminV1,
} from '../dist/search.js';

const IMAGE =
  'qdrant/qdrant:v1.18.2@sha256:da65a06bc75e42702f80c992b99c5144b0fbd675ae7a96d2991de0bf957b7071';
const PLATFORM = 'linux/amd64';
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
  const inspectedPlatform = spawnSync(
    'docker',
    ['image', 'inspect', IMAGE, '--format', '{{.Os}}/{{.Architecture}}'],
    { encoding: 'utf8' },
  );
  assert(
    inspectedPlatform.status === 0 &&
      inspectedPlatform.stdout.trim() === PLATFORM,
    `Qdrant image platform must be ${PLATFORM}`,
  );
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
  await protectedSemanticLifecycle(endpoint, collection);
  console.log(
    JSON.stringify({
      image: IMAGE,
      platform: PLATFORM,
      dimensions: 3,
      metric: 'cosine',
      lifecycle:
        'validate/upsert/authorized-query/isolation/delete/protected-semantic-restart',
      passed: true,
    }),
  );
} finally {
  spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
}

async function protectedSemanticLifecycle(qdrantEndpoint, collection) {
  const directory = mkdtempSync(join(tmpdir(), 'taproot-qdrant-semantic-'));
  const path = join(directory, 'semantic.sqlite');
  const options = { baseIri: 'https://qdrant-semantic.example' };
  const installationId = 'qdrant-semantic-installation';
  const mockEndpoint = 'http://127.0.0.1:9/v1/embeddings';
  const semanticFetch = (input, init) => {
    const url =
      input instanceof Request
        ? input.url
        : input instanceof globalThis.URL
          ? input.href
          : input;
    if (url === mockEndpoint) {
      const body = JSON.parse(String(init?.body));
      return Promise.resolve(
        new globalThis.Response(
          JSON.stringify({
            data: body.input.map(() => ({ embedding: [1, 0, 0] })),
            usage: { total_tokens: body.input.length },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    return globalThis.fetch(input, init);
  };
  let database = new NodeSqliteDatabase(path);
  try {
    await initializeTaproot(database, options);
    const key = await webcrypto.subtle.generateKey(
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const authority = createTaprootHostWriteCapability(database, options, key);
    const bootstrapOwner = await registerAuthorizationBootstrapOwnerV1(
      database,
      options,
      authority,
      {
        installationId,
        ownerRegistrationId: 'qdrant-semantic-bootstrap-owner',
        adapter: {
          kind: 'taproot-authorization-bootstrap-owner-adapter-v1',
          prepare: () => Promise.resolve({ statements: [], receipt: {} }),
        },
      },
    );
    const bootstrap = await prepareAuthorizationBootstrapV1(
      database,
      options,
      authority,
      {
        installationId,
        baseIri: options.baseIri,
        principalId: 'admin',
        workspaceId: 'workspace-1',
        grants: [
          KNOWLEDGE_POLICY_CAPABILITY,
          'knowledge:read',
          KNOWLEDGE_WRITE_CAPABILITY,
          'search:admin',
        ],
        idempotencyKey: 'qdrant-semantic-bootstrap',
      },
    );
    await commitAuthorizationBootstrapV1(
      bootstrap,
      await bootstrapOwner.seal(bootstrap, {}),
    );
    const port = await createTaprootWorkshopPortV1(
      database,
      options,
      authority,
      { installationId },
    );
    let adminContext = await port.resolveAuthorization({
      principalId: 'admin',
      activeWorkspaceId: 'workspace-1',
    });
    await port.createItem(
      {
        id: 'Q1',
        labels: {
          en: { language: 'en', value: 'Protected semantic Qdrant result' },
        },
      },
      { idempotencyKey: 'qdrant-semantic-q1' },
      adminContext,
    );
    adminContext = await port.resolveAuthorization({
      principalId: 'admin',
      activeWorkspaceId: 'workspace-1',
    });
    const materialization = await createSearchMaterializationAdminGuardV1(
      database,
      options,
      authority,
    );
    await materialization.initialize(adminContext);
    await materialization.run(adminContext, {
      maxJobs: 100,
      maxRebuildRoots: 100,
    });
    const createSemantic = () =>
      createSemanticSearchAdminV1(database, {
        installationId,
        fetch: semanticFetch,
      });
    const semantic = createSemantic();
    await semantic.configure(
      {
        version: 1,
        id: 'protected-qdrant',
        name: 'protected-qdrant',
        provider: {
          kind: 'openai-compatible',
          endpoint: mockEndpoint,
          model: 'deterministic',
          dimensions: 3,
          metric: 'cosine',
          credentialSelector: null,
          allowPrivateEndpoint: true,
          redirectPolicy: 'error',
        },
        vector: {
          kind: 'qdrant',
          endpoint: qdrantEndpoint,
          collection,
          credentialSelector: null,
          allowPrivateEndpoint: true,
          redirectPolicy: 'error',
        },
      },
      { expectedRevision: 0, idempotencyKey: 'protected-qdrant-v1' },
      adminContext,
    );
    const { planId } = await semantic.estimate(
      'protected-qdrant',
      { mode: 'asap' },
      adminContext,
    );
    await semantic.approve(planId, adminContext);
    await semantic.run(planId, adminContext);
    await semantic.select('protected-qdrant', adminContext);
    const status = await semantic.status(adminContext);
    assert(
      status.ready && status.state === 'ready',
      'Qdrant semantic not ready',
    );
    const query = {
      text: 'protected semantic',
      kinds: ['item'],
      limit: 10,
      context: { ...adminContext, capabilities: [] },
    };
    const beforeRestart = await semantic.search(query);
    assert(beforeRestart.length === 1, 'Qdrant semantic search was empty');

    await database.close();
    database = new NodeSqliteDatabase(path);
    const restarted = createSemantic();
    const afterRestart = await restarted.search(query);
    assert(
      afterRestart.length === 1,
      'Qdrant semantic search did not survive restart',
    );
  } finally {
    await database.close();
    rmSync(directory, { recursive: true, force: true });
  }
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
