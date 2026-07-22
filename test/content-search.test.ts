import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { D1DatabaseLike } from '@gnolith/diamond';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_POLICY_CAPABILITY,
  KNOWLEDGE_WRITE_CAPABILITY,
  SEARCH_ADMIN_CAPABILITY,
  TaprootContentRepositoryV1,
  bootstrapTaprootAuthorization,
  createAuthorizedSearchServiceV1,
  createInstallationAuthorizationGuard,
  createSemanticSearchAdminV1,
  createItem,
  createSearchMaterializationAdminGuardV1,
  createSqliteVectorIndexV1,
  createTaprootHostWriteCapability,
  initializeTaproot,
  type AuthorizationContext,
  type CanonicalAuthorizationPolicyInput,
  type EmbeddingProviderPortV1,
  type TaprootHostWriteCapability,
  type VisibilityScopeV1,
} from '../src/index.js';

const options = { baseIri: 'https://content-search.example' };
const installationId = 'installation-content-search';
const directories: string[] = [];
const PUBLIC: VisibilityScopeV1 = { version: 1, clauses: [] };

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

for (const runtime of [nodeRuntime(), workerdRuntime()]) {
  describe(`canonical content and public search on ${runtime.name}`, () => {
    it('keeps Item, Resource, and Annotation identities distinct and invalidates revisions atomically', async () => {
      const env = await runtime.create();
      try {
        await bootstrapTaprootAuthorization(
          env.db,
          options,
          env.capability,
          installationId,
        );
        const text = Array.from(
          { length: 20 },
          () => 'Shared Needle resource body',
        ).join(' ');
        const payloadStore = {
          kind: 'taproot-resource-payload-store-v1' as const,
          load: () => Promise.resolve(new TextEncoder().encode(text)),
        };
        const materialization = await createSearchMaterializationAdminGuardV1(
          env.db,
          options,
          env.capability,
          { payloadStore },
        );
        await materialization.initialize(admin(1));
        const guard = await createInstallationAuthorizationGuard(
          env.db,
          options,
          env.capability,
        );
        await createItem(env.db, options, guard, writer(1), {
          id: 'Q1',
          labels: { en: { language: 'en', value: 'Shared Needle Item' } },
          authorization: policy(1),
        });
        const content = new TaprootContentRepositoryV1(env.db, {
          installationId,
          payloadStore,
          createId: (() => {
            let value = 0;
            return () => `content-event-${++value}`;
          })(),
        });
        const resource = await content.createResource(
          {
            id: 'resource-1',
            itemId: 'Q1',
            title: 'Shared Needle Resource',
            payload: {
              kind: 'location',
              storage: 'blob',
              location: 'blob://resource-1',
              byteLength: new TextEncoder().encode(text).byteLength,
            },
            mediaType: 'text/plain',
            language: 'en',
            integrity: {
              algorithm: 'sha256',
              digest: await digest(text),
              byteLength: new TextEncoder().encode(text).byteLength,
            },
          },
          metadata(2),
        );
        const annotation = await content.createAnnotation(
          {
            id: 'annotation-1',
            body: { kind: 'text', text: 'Shared Needle annotation body' },
            target: {
              kind: 'resource',
              sourceId: resource.id,
              selector: { type: 'TextQuoteSelector', exact: 'Needle' },
            },
            targetVisibility: PUBLIC,
            motivation: 'commenting',
          },
          metadata(3),
        );
        await materialization.run(admin(4), runOptions());
        const search = createAuthorizedSearchServiceV1(env.db, {
          installationId,
          content,
        });
        const page = await search.search({ text: 'Shared Needle' }, reader(4));
        expect(page.results.map(({ kind }) => kind)).toEqual(
          expect.arrayContaining(['item', 'resource', 'annotation']),
        );
        expect(
          page.results.filter(({ kind }) => kind === 'resource').length,
        ).toBeGreaterThan(1);
        expect(
          page.results.filter(({ kind }) => kind === 'annotation'),
        ).toHaveLength(1);
        expect(
          page.results.every(({ snippet }) => [...snippet].length <= 242),
        ).toBe(true);
        const firstPage = await search.search(
          { text: 'Shared Needle', limit: 1 },
          reader(4),
        );
        expect(firstPage.results).toHaveLength(1);
        expect(firstPage.cursor).toBeDefined();
        await expect(
          search.search(
            { text: 'different query', limit: 1, cursor: firstPage.cursor! },
            reader(4),
          ),
        ).rejects.toThrow(/cursor/u);
        await expect(
          search.search(
            { text: 'Shared Needle', kinds: ['unknown' as 'item'] },
            reader(4),
          ),
        ).rejects.toThrow(/kind/u);
        await expect(
          search.search({ text: 'Shared Needle', limit: 101 }, reader(4)),
        ).rejects.toThrow(/limit/u);

        const hydrated = await search.hydrate(
          page.results.find(({ kind }) => kind === 'annotation')!,
          reader(4),
        );
        expect(hydrated).toMatchObject({ id: annotation.id, revision: 1 });
        await expect(
          content.hydrateResourcePayload(resource.id, reader(4)),
        ).resolves.toEqual(new TextEncoder().encode(text));

        let semantic:
          | {
              admin: ReturnType<typeof createSemanticSearchAdminV1>;
              planId: string;
            }
          | undefined;
        if (runtime.name === 'persisted native SQLite') {
          const provider: EmbeddingProviderPortV1 = {
            identity: {
              kind: 'openai-compatible',
              endpoint: 'https://embedding.example',
              model: 'deterministic-test',
              dimensions: 2,
              metric: 'cosine',
            },
            embed: (input) =>
              Promise.resolve({
                vectors: input.map(() => [1, 0]),
                usage: { tokens: input.length },
              }),
          };
          const semanticAdmin = createSemanticSearchAdminV1(env.db, {
            installationId,
          });
          await semanticAdmin.configure(
            {
              id: 'semantic-content',
              name: 'content',
              provider,
              vectorIndex: createSqliteVectorIndexV1(env.db),
            },
            admin(4),
          );
          const estimated = await semanticAdmin.estimate(
            'semantic-content',
            { mode: 'asap' },
            admin(4),
          );
          semantic = { admin: semanticAdmin, planId: estimated.planId };
        }

        await content.updateResource(
          resource.id,
          1,
          {
            payload: { kind: 'inline-text', text: 'Replacement corpus text' },
            integrity: {
              algorithm: 'sha256',
              digest: await digest('Replacement corpus text'),
              byteLength: new TextEncoder().encode('Replacement corpus text')
                .byteLength,
            },
          },
          metadata(4),
        );
        await expect(
          search.hydrate(
            page.results.find(({ kind }) => kind === 'resource')!,
            reader(5),
          ),
        ).rejects.toThrow(/stale/u);
        expect(
          (await search.search({ text: 'resource body' }, reader(5))).results,
        ).toHaveLength(0);
        await materialization.run(admin(5), runOptions());
        expect(
          (
            await search.search(
              { text: 'Replacement corpus', kinds: ['resource'] },
              reader(5),
            )
          ).results[0],
        ).toMatchObject({ kind: 'resource', sourceId: 'resource-1' });
        if (semantic) {
          await semantic.admin.approve(semantic.planId, admin(5));
          await semantic.admin.run(semantic.planId, admin(5));
          const work = await env.db
            .prepare(
              `SELECT state, source_revision FROM taproot_embedding_work WHERE plan_id=? AND derived_id IN (
                 SELECT COALESCE(c.chunk_id,d.document_id)
                 FROM taproot_search_materialization_heads h
                 JOIN taproot_search_staged_documents d ON d.stage_id=h.current_stage_id
                 LEFT JOIN taproot_search_chunks c ON c.stage_id=d.stage_id AND c.document_slot=d.document_slot
                 WHERE h.root_kind='resource' AND h.root_id='resource-1'
               )`,
            )
            .bind(semantic.planId)
            .all<{ state: string; source_revision: string }>();
          expect(work.results.length).toBeGreaterThan(0);
          expect(work.results).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                state: 'complete',
                source_revision: '2',
              }),
            ]),
          );
        }
      } finally {
        await env.close();
      }
    }, 60_000);
  });
}

function metadata(revision: number) {
  return {
    context: writer(revision),
    attribution: { id: 'author-1', kind: 'human' as const },
    workspaceId: 'workspace-1',
    ownerPrincipalId: 'principal-1',
    visibility: PUBLIC,
    expectedAuthorizationRevision: revision,
  };
}

function writer(revision: number): AuthorizationContext {
  return {
    installationId,
    principalId: 'principal-1',
    activeWorkspaceId: 'workspace-1',
    workspaceIds: ['workspace-1'],
    capabilities: [KNOWLEDGE_WRITE_CAPABILITY, KNOWLEDGE_POLICY_CAPABILITY],
    authorizationRevision: revision,
  };
}

function reader(revision: number): AuthorizationContext {
  return { ...writer(revision), capabilities: [] };
}

function admin(revision: number): AuthorizationContext {
  return { ...writer(revision), capabilities: [SEARCH_ADMIN_CAPABILITY] };
}

function policy(revision: number): CanonicalAuthorizationPolicyInput {
  return {
    installationId,
    workspaceId: 'workspace-1',
    ownerPrincipalId: 'principal-1',
    visibility: PUBLIC,
    statementRestrictions: {},
    expectedAuthorizationRevision: revision,
  };
}

function runOptions() {
  return {
    maxJobs: 20,
    maxRebuildRoots: 20,
    maxChunkBytes: 64,
    leaseMilliseconds: 30_000,
  };
}

async function digest(value: string): Promise<string> {
  const result = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(result)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function nodeRuntime() {
  return {
    name: 'persisted native SQLite',
    async create() {
      const directory = mkdtempSync(join(tmpdir(), 'taproot-content-native-'));
      directories.push(directory);
      const db = new NodeSqliteDatabase(join(directory, 'taproot.sqlite'));
      await initializeTaproot(db, options);
      return {
        db,
        capability: await hostCapability(db),
        close: () => db.close(),
      };
    },
  };
}

function workerdRuntime() {
  return {
    name: 'real Workerd D1',
    async create() {
      const directory = mkdtempSync(join(tmpdir(), 'taproot-content-d1-'));
      directories.push(directory);
      const miniflare = new Miniflare({
        modules: true,
        script: 'export default { fetch() { return new Response("ok") } }',
        compatibilityDate: '2026-07-19',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: crypto.randomUUID() },
        d1Persist: directory,
      });
      const db = (await miniflare.getD1Database(
        'DB',
      )) as unknown as D1DatabaseLike;
      await initializeTaproot(db, options);
      return {
        db,
        capability: await hostCapability(db),
        close: () => miniflare.dispose(),
      };
    },
  };
}

async function hostCapability(
  db: D1DatabaseLike,
): Promise<TaprootHostWriteCapability> {
  const key = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return createTaprootHostWriteCapability(db, options, key);
}
