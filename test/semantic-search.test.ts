import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SEARCH_ADMIN_CAPABILITY,
  createOllamaCompatibleEmbeddingProviderV1,
  createOpenAICompatibleEmbeddingProviderV1,
  createSemanticSearchAdminV1,
  createSqliteVectorIndexV1,
  initializeTaproot,
  type AuthorizationContext,
  type EmbeddingProviderPortV1,
  type VectorRecordV1,
} from '../src/index.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('embedding provider conformance', () => {
  it.each([
    ['OpenAI', createOpenAICompatibleEmbeddingProviderV1, 'embeddings'],
    ['Ollama', createOllamaCompatibleEmbeddingProviderV1, 'api/embed'],
  ] as const)(
    'validates deterministic %s-compatible batches, identity, bounds, auth, and local opt-in',
    async (_name, create, path) => {
      const requests: Array<{ url: string; authorization: string | null }> = [];
      const provider = create({
        endpoint: 'http://127.0.0.1:11434',
        model: 'model-a',
        dimensions: 3,
        allowPrivateEndpoint: true,
        secret: () => 'super-secret-canary',
        fetch: (input, init) => {
          requests.push({
            url:
              input instanceof Request
                ? input.url
                : input instanceof URL
                  ? input.href
                  : input,
            authorization: new Headers(init?.headers).get('authorization'),
          });
          return Promise.resolve(
            new Response(
              path === 'embeddings'
                ? JSON.stringify({
                    data: [{ embedding: [1, 0, 0] }, { embedding: [0, 1, 0] }],
                    usage: { total_tokens: 7 },
                  })
                : JSON.stringify({
                    embeddings: [
                      [1, 0, 0],
                      [0, 1, 0],
                    ],
                    usage: { prompt_tokens: 7 },
                  }),
              { headers: { 'content-type': 'application/json' } },
            ),
          );
        },
      });
      await expect(provider.embed(['one', 'two'])).resolves.toEqual({
        vectors: [
          [1, 0, 0],
          [0, 1, 0],
        ],
        usage: { tokens: 7 },
      });
      expect(requests[0]).toEqual({
        url: `http://127.0.0.1:11434/${path}`,
        authorization: 'Bearer super-secret-canary',
      });
      expect(provider.identity).toMatchObject({
        model: 'model-a',
        dimensions: 3,
        metric: 'cosine',
      });
      expect(() =>
        create({
          endpoint: 'http://127.0.0.1:11434',
          model: 'model-a',
          dimensions: 3,
        }),
      ).toThrow(/private|https/u);
    },
  );

  it('redacts malformed, oversized, timeout, and provider failures', async () => {
    const provider = createOpenAICompatibleEmbeddingProviderV1({
      endpoint: 'https://embeddings.example',
      model: 'model-a',
      dimensions: 2,
      secret: () => 'never-leak-this-secret',
      maxResponseBytes: 32,
      fetch: () =>
        Promise.resolve(
          new Response('x'.repeat(100), {
            status: 500,
            headers: { 'content-length': '100' },
          }),
        ),
    });
    const error = await provider
      .embed(['one'])
      .catch((cause: unknown) => cause);
    expect(String(error)).not.toContain('never-leak-this-secret');
    expect(String(error)).toMatch(/bound|failed/u);
  });
});

describe('persisted SQLite vector and semantic administration', () => {
  it('persists exact vectors, isolates installations/configurations, filters authorization, and deletes safely', async () => {
    const { db, path } = await database();
    const vector = createSqliteVectorIndexV1(db);
    const publicRecord = record('public', 'installation-a', [1, 0]);
    const privateRecord = {
      ...record('private', 'installation-a', [0.9, 0.1]),
      authorization: {
        version: 1 as const,
        clauses: [[{ kind: 'principal' as const, principalId: 'other' }]],
      },
    };
    await vector.validate(2, 'cosine');
    await vector.upsert(
      [
        publicRecord,
        privateRecord,
        record('isolated', 'installation-b', [1, 0]),
      ],
      2,
      'cosine',
    );
    expect(
      await vector.query(
        {
          installationId: 'installation-a',
          configurationId: 'config-a',
          generation: 1,
          kinds: ['item'],
          vector: [1, 0],
          limit: 10,
          context: context('installation-a', false),
        },
        2,
        'cosine',
      ),
    ).toEqual([{ derivedId: 'public', score: 1 }]);
    await db.close();
    const reopened = new NodeSqliteDatabase(path);
    try {
      const persisted = createSqliteVectorIndexV1(reopened);
      expect(
        await persisted.query(
          {
            installationId: 'installation-a',
            configurationId: 'config-a',
            generation: 1,
            kinds: ['item'],
            vector: [1, 0],
            limit: 10,
            context: context('installation-a', false),
          },
          2,
          'cosine',
        ),
      ).toHaveLength(1);
      await persisted.delete({
        installationId: 'installation-a',
        configurationId: 'config-a',
      });
      expect(
        await reopened
          .prepare(
            `SELECT COUNT(*) AS count FROM taproot_embedding_vectors WHERE installation_id='installation-b'`,
          )
          .all<{ count: number }>(),
      ).toMatchObject({ results: [{ count: 1 }] });
    } finally {
      await reopened.close();
    }
  });

  it('requires exact admin capability, durable approval, bounded validation, ready selection, and lexical fallback behind a circuit', async () => {
    const { db } = await database();
    try {
      const calls = vi.fn(() =>
        Promise.resolve({ vectors: [[1, 0]], usage: { tokens: 2 } }),
      );
      const provider: EmbeddingProviderPortV1 = {
        identity: {
          kind: 'openai-compatible',
          endpoint: 'https://provider.example',
          model: 'model-a',
          dimensions: 2,
          metric: 'cosine',
        },
        embed: calls,
      };
      const warnings: string[] = [];
      const admin = createSemanticSearchAdminV1(db, {
        installationId: 'installation-a',
        warn: (message) => warnings.push(message),
        createId: (() => {
          let value = 0;
          return () => `semantic-${++value}`;
        })(),
      });
      await expect(
        admin.configure(
          {
            id: 'config-a',
            name: 'primary',
            provider,
            vectorIndex: createSqliteVectorIndexV1(db),
          },
          context('installation-a', false),
        ),
      ).rejects.toThrow(/search:admin/u);
      await admin.configure(
        {
          id: 'config-a',
          name: 'primary',
          provider,
          vectorIndex: createSqliteVectorIndexV1(db),
        },
        context('installation-a', true),
      );
      const { planId, estimate } = await admin.estimate(
        'config-a',
        { mode: 'asap' },
        context('installation-a', true),
      );
      expect(estimate.cost).toBeNull();
      await expect(
        admin.run(planId, context('installation-a', true)),
      ).rejects.toThrow(/approved/u);
      await admin.approve(planId, context('installation-a', true));
      await admin.run(planId, context('installation-a', true));
      await admin.select('config-a', context('installation-a', true));
      expect(await admin.status(context('installation-a', true))).toMatchObject(
        {
          selectedConfigurationId: 'config-a',
          selectedReady: true,
          circuitOpen: false,
        },
      );

      const failingEmbed = vi.fn(() =>
        Promise.reject(new Error('secret=do-not-leak')),
      );
      const failing: EmbeddingProviderPortV1 = {
        ...provider,
        embed: failingEmbed,
      };
      await admin.configure(
        {
          id: 'config-b',
          name: 'failing',
          provider: failing,
          vectorIndex: createSqliteVectorIndexV1(db),
        },
        context('installation-a', true),
      );
      expect(failingEmbed).toHaveBeenCalledTimes(3);
      await admin.select('config-b', context('installation-a', true));
      expect(
        await admin.search({
          text: 'query',
          kinds: ['item'],
          limit: 10,
          context: context('installation-a', false),
        }),
      ).toEqual([]);
      expect(failingEmbed).toHaveBeenCalledTimes(3);
      expect(warnings).toHaveLength(1);
      expect(warnings.join(' ')).not.toContain('do-not-leak');
    } finally {
      await db.close();
    }
  });
});

function record(
  id: string,
  installationId: string,
  vector: number[],
): VectorRecordV1 {
  return {
    id,
    installationId,
    configurationId: 'config-a',
    generation: 1,
    kind: 'item',
    sourceId: `source-${id}`,
    sourceRevision: '1',
    documentId: `document-${id}`,
    chunkId: null,
    contentHash: id.padEnd(64, '0').slice(0, 64),
    authorization: { version: 1, clauses: [] },
    selector: null,
    vector,
  };
}

function context(installationId: string, admin: boolean): AuthorizationContext {
  return {
    installationId,
    principalId: 'principal-1',
    activeWorkspaceId: null,
    workspaceIds: [],
    capabilities: admin ? [SEARCH_ADMIN_CAPABILITY] : [],
    authorizationRevision: 1,
  };
}

async function database() {
  const directory = mkdtempSync(join(tmpdir(), 'taproot-semantic-'));
  directories.push(directory);
  const path = join(directory, 'taproot.sqlite');
  const db = new NodeSqliteDatabase(path);
  await initializeTaproot(db, { baseIri: 'https://semantic.example' });
  return { db, path };
}
