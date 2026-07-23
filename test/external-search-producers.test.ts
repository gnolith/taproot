import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { D1DatabaseLike } from '@gnolith/diamond';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InvalidAuthorizationError,
  applyTaprootMigrations,
  bootstrapTaprootAuthorization,
  createExternalSearchDomainMutationCoordinatorV1,
  createExternalSearchDomainPolicyAuthorityV1,
  createExternalSearchProducerGuardV1,
  createSearchMaterializationAdminGuardV1,
  createTaprootHostWriteCapability,
  type AuthorizationContext,
  type ExternalSearchProducerCallbacksV1,
  type TaprootHostWriteCapability,
} from '../src/index.js';

const options = { baseIri: 'https://external-producers.example' };
const installationId = 'external-producer-installation';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

for (const runtime of [nodeRuntime(), workerdRuntime()]) {
  describe(`host-sealed producer boundary on ${runtime.name}`, () => {
    it('materializes a data-only Task plan with Taproot-derived identity, chunks, and authority', async () => {
      const env = await runtime.create();
      try {
        const canonical = {
          version: 1,
          taskId: 'task-materialized',
          revision: 1,
          title: 'Bounded task title',
        };
        const setup = await producer(env.db, env.capability, 'task', 'f', {
          loadCurrent: ({ sourceId }) =>
            Promise.resolve({
              sourceId,
              sourceRevision: '1',
              sourcePolicyRevision: 7,
              canonical,
            }),
          projectCurrent: () =>
            Promise.resolve({
              version: 1,
              replaceAll: true,
              removeDocumentSlots: [],
              documents: [
                {
                  documentSlot: 'task-title',
                  canonicalReference: {
                    kind: 'task',
                    taskId: 'task-materialized',
                  },
                  filterMetadata: {
                    languages: [],
                    sourceRevisions: ['1'],
                    byKind: { task: { statuses: ['open'] } },
                  },
                  text: 'Bounded task title',
                  segments: [
                    {
                      field: 'title',
                      sourceId: 'task-materialized',
                      language: null,
                      text: 'Bounded task title',
                      documentStart: 0,
                      documentEnd: 18,
                    },
                  ],
                },
              ],
            }),
        });
        await setup.guard.adoptLegacyPage(adminContext(), { limit: 10 });
        const materialization = await createSearchMaterializationAdminGuardV1(
          env.db,
          options,
          env.capability,
        );
        await materialization.initialize(adminContext());
        await env.db
          .prepare(
            `UPDATE taproot_unified_search_generation_producers
             SET state = 'ready', producer_fingerprint = ?,
                 contract_version = 'workshop-search-producer-v1',
                 projection_version = 'workshop-search-projection-v1',
                 authorization_contract_version = 'workshop-search-authorization-v1'
             WHERE installation_id = ? AND source_kind = 'task'`,
          )
          .bind('f'.repeat(64), installationId)
          .run();
        await env.db
          .prepare(
            `CREATE TABLE workshop_tasks(
               task_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
               title TEXT NOT NULL
             ) STRICT`,
          )
          .run();
        const handle = await setup.coordinator.sealCanonicalMutation({
          context: taskContext(),
          eventId: 'task-materialization-event',
          sourceId: 'task-materialized',
          operation: 'upsert',
          changeClass: 'canonical',
          sourceRevision: '1',
          sourcePolicyRevision: 7,
          predecessor: null,
          canonicalPostState: canonical,
          statements: [
            {
              sql: `INSERT INTO workshop_tasks(task_id, revision, title)
                    VALUES (?, ?, ?)`,
              values: ['task-materialized', 1, 'Bounded task title'],
            },
          ],
        });
        await setup.guard.commitCanonicalMutation(handle);
        expect(
          await materialization.run(adminContext(), {
            maxJobs: 10,
            maxRebuildRoots: 10,
            maxChunkBytes: 64,
            leaseMilliseconds: 30_000,
          }),
        ).toMatchObject({ claimed: 1, completed: 1, dead: 0 });
        const document = await row(
          env.db,
          `SELECT document_id, document_hash, document_kind,
                  authorization_fingerprint, document_text
           FROM taproot_search_staged_documents
           WHERE document_slot = 'task-title'`,
        );
        expect(document).toMatchObject({
          document_kind: 'task',
          document_text: 'Bounded task title',
        });
        expect(String(document?.document_id)).toMatch(
          /^taproot:document:v1:[a-f0-9]{64}$/u,
        );
        expect(String(document?.document_hash)).toHaveLength(64);
        expect(String(document?.authorization_fingerprint)).toHaveLength(64);
        expect(
          await scalar(env.db, `SELECT COUNT(*) FROM taproot_search_chunks`),
        ).toBe(1);
      } finally {
        await env.close();
      }
    }, 30_000);

    it('persists a redacted adoption failure without exposing callback errors', async () => {
      const env = await runtime.create();
      try {
        const setup = await producer(env.db, env.capability, 'memory', 'e', {
          enumerateLegacyCurrent: () =>
            Promise.reject(new Error('callback-secret-must-not-escape')),
        });
        let failure: unknown;
        try {
          await setup.guard.adoptLegacyPage(adminContext(), { limit: 10 });
        } catch (cause) {
          failure = cause;
        }
        expect(failure).toBeInstanceOf(InvalidAuthorizationError);
        expect(String(failure)).toBe(
          'InvalidAuthorizationError: external producer adoption failed',
        );
        expect((failure as { cause?: unknown }).cause).toBeUndefined();
        expect(
          await row(
            env.db,
            `SELECT state, last_error_code
             FROM taproot_unified_search_producer_adoptions
             WHERE installation_id = '${installationId}' AND source_kind = 'memory'`,
          ),
        ).toEqual({
          state: 'failed',
          last_error_code: 'producer-adoption-failed',
        });
        expect(
          await scalar(
            env.db,
            `SELECT COUNT(*) FROM taproot_unified_search_producer_admin_audit
             WHERE source_kind = 'memory' AND event_type = 'adoption-failed'`,
          ),
        ).toBe(1);
      } finally {
        await env.close();
      }
    }, 30_000);

    it('persists adoption and requires process-local capability reconstruction after restart', async () => {
      const first = await runtime.create();
      let firstClosed = false;
      try {
        const setup = await producer(
          first.db,
          first.capability,
          'task',
          'd',
          pagedCallbacks(),
        );
        const staleHandle = await setup.coordinator.sealCanonicalMutation({
          context: taskContext(),
          eventId: 'restart-stale-handle',
          sourceId: 'task-restart',
          operation: 'upsert',
          changeClass: 'canonical',
          sourceRevision: '1',
          sourcePolicyRevision: 4,
          predecessor: null,
          canonicalPostState: { taskId: 'task-restart', revision: 1 },
          statements: [{ sql: `SELECT ?`, values: [1] }],
        });
        expect(
          await setup.guard.adoptLegacyPage(adminContext(), { limit: 10 }),
        ).toEqual({ enumerated: 0, adopted: 0, complete: false });
        expect(
          await row(
            first.db,
            `SELECT state, producer_fingerprint, opaque_cursor,
                    enumerated_count, adopted_count
             FROM taproot_unified_search_producer_adoptions
             WHERE installation_id = '${installationId}' AND source_kind = 'task'`,
          ),
        ).toEqual({
          state: 'backfilling',
          producer_fingerprint: 'd'.repeat(64),
          opaque_cursor: 'page-2',
          enumerated_count: 0,
          adopted_count: 0,
        });

        await first.close();
        firstClosed = true;
        const second = await first.reopen();
        try {
          const reconstructed = await producer(
            second.db,
            second.capability,
            'task',
            'd',
            pagedCallbacks(),
          );
          expect(
            await reconstructed.guard.adoptLegacyPage(adminContext(), {
              limit: 10,
            }),
          ).toEqual({ enumerated: 0, adopted: 0, complete: true });
          expect(
            await scalar(
              second.db,
              `SELECT COUNT(*) FROM taproot_unified_search_producer_admin_audit
               WHERE source_kind = 'task' AND event_type = 'adoption-ready'`,
            ),
          ).toBe(1);
          await expect(
            reconstructed.guard.commitCanonicalMutation(staleHandle),
          ).rejects.toBeInstanceOf(InvalidAuthorizationError);
          expect(
            await row(
              second.db,
              `SELECT state, producer_fingerprint
               FROM taproot_unified_search_producer_adoptions
               WHERE installation_id = '${installationId}' AND source_kind = 'task'`,
            ),
          ).toEqual({ state: 'ready', producer_fingerprint: 'd'.repeat(64) });
        } finally {
          await second.close();
        }
      } finally {
        if (!firstClosed) await first.close();
      }
    }, 30_000);

    it('commits one same-database mutation+event and rejects forgery, replay, and rollback leaks', async () => {
      const env = await runtime.create();
      try {
        const setup = await producer(env.db, env.capability, 'task', 'a');
        await env.db
          .prepare(
            `CREATE TABLE workshop_tasks(
               task_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
               title TEXT NOT NULL
             ) STRICT`,
          )
          .run();
        const handle = await setup.coordinator.sealCanonicalMutation({
          context: taskContext(),
          eventId: 'task-event-1',
          sourceId: 'task-1',
          operation: 'upsert',
          changeClass: 'canonical',
          sourceRevision: '1',
          sourcePolicyRevision: 7,
          predecessor: null,
          canonicalPostState: {
            version: 1,
            taskId: 'task-1',
            revision: 1,
            title: 'bounded canonical text',
          },
          statements: [
            {
              sql: `INSERT INTO workshop_tasks(task_id, revision, title)
                    VALUES (?, ?, ?)`,
              values: ['task-1', 1, 'bounded canonical text'],
            },
          ],
        });
        expect(await setup.guard.commitCanonicalMutation(handle)).toMatchObject(
          {
            eventId: 'task-event-1',
            authorizationRevision: 1,
            searchGeneration: 2,
          },
        );
        expect(
          await scalar(env.db, `SELECT COUNT(*) FROM workshop_tasks`),
        ).toBe(1);
        expect(
          await row(
            env.db,
            `SELECT source_policy_revision, authorization_revision
            FROM taproot_unified_search_source_events WHERE event_id = 'task-event-1'`,
          ),
        ).toEqual({ source_policy_revision: 7, authorization_revision: 1 });
        await expect(
          setup.guard.commitCanonicalMutation(handle),
        ).rejects.toBeInstanceOf(InvalidAuthorizationError);
        await expect(
          setup.guard.commitCanonicalMutation(
            Object.freeze({
              kind: 'taproot-external-search-canonical-mutation-v1',
            }),
          ),
        ).rejects.toBeInstanceOf(InvalidAuthorizationError);

        const failing = await setup.coordinator.sealCanonicalMutation({
          context: taskContext(),
          eventId: 'task-event-2',
          sourceId: 'task-2',
          operation: 'upsert',
          changeClass: 'canonical',
          sourceRevision: '1',
          sourcePolicyRevision: 8,
          predecessor: null,
          canonicalPostState: { version: 1, taskId: 'task-2', revision: 1 },
          statements: [
            {
              sql: `INSERT INTO workshop_tasks(task_id, revision, title)
                    VALUES (?, ?, ?)`,
              values: ['task-1', 2, 'must roll back'],
            },
          ],
        });
        await expect(
          setup.guard.commitCanonicalMutation(failing),
        ).rejects.toThrow();
        expect(
          await scalar(
            env.db,
            `SELECT COUNT(*) FROM taproot_unified_search_source_events`,
          ),
        ).toBe(1);
        expect(
          await scalar(
            env.db,
            `SELECT search_generation FROM taproot_installation_authorization
             WHERE singleton = 1`,
          ),
        ).toBe(2);
      } finally {
        await env.close();
      }
    }, 30_000);

    it('serializes 18 simultaneous Task, Memory, and Prompt commits without generation collisions', async () => {
      const env = await runtime.create();
      try {
        const producers = {
          task: await producer(env.db, env.capability, 'task', '1'),
          memory: await producer(env.db, env.capability, 'memory', '2'),
          prompt: await producer(env.db, env.capability, 'prompt', '3'),
        } as const;
        await env.db
          .prepare(
            `CREATE TABLE workshop_concurrent_sources(
               source_kind TEXT NOT NULL,
               source_id TEXT NOT NULL,
               event_id TEXT NOT NULL,
               PRIMARY KEY(source_kind, source_id)
             ) STRICT`,
          )
          .run();
        const kinds = ['task', 'memory', 'prompt'] as const;
        const handles = await Promise.all(
          Array.from({ length: 18 }, async (_, index) => {
            const kind = kinds[index % kinds.length]!;
            const sourceId = `${kind}-concurrent-${index}`;
            const eventId = `${kind}-concurrent-event-${index}`;
            return {
              kind,
              handle: await producers[kind].coordinator.sealCanonicalMutation({
                context: producerContext(kind),
                eventId,
                sourceId,
                operation: 'upsert',
                changeClass: 'canonical',
                sourceRevision: '1',
                sourcePolicyRevision: 1,
                predecessor: null,
                canonicalPostState: { kind, sourceId, revision: 1 },
                statements: [
                  {
                    sql: `INSERT INTO workshop_concurrent_sources(
                            source_kind, source_id, event_id
                          ) VALUES (?, ?, ?)`,
                    values: [kind, sourceId, eventId],
                  },
                ],
              }),
            };
          }),
        );
        const receipts = await Promise.all(
          handles.map(({ kind, handle }) =>
            producers[kind].guard.commitCanonicalMutation(handle),
          ),
        );
        expect(
          receipts
            .map(({ searchGeneration }) => searchGeneration)
            .sort((left, right) => left - right),
        ).toEqual(Array.from({ length: 18 }, (_, index) => index + 2));
        expect(
          await scalar(
            env.db,
            `SELECT COUNT(*) FROM workshop_concurrent_sources`,
          ),
        ).toBe(18);
        expect(
          await scalar(
            env.db,
            `SELECT COUNT(*) FROM taproot_unified_search_source_events`,
          ),
        ).toBe(18);
        expect(
          await scalar(
            env.db,
            `SELECT search_generation FROM taproot_installation_authorization
             WHERE singleton = 1`,
          ),
        ).toBe(19);

        const sameSourceHandles = await Promise.all(
          ['a', 'b'].map((suffix) =>
            producers.task.coordinator.sealCanonicalMutation({
              context: producerContext('task'),
              eventId: `same-source-event-${suffix}`,
              sourceId: 'task-same-source',
              operation: 'upsert',
              changeClass: 'canonical',
              sourceRevision: '1',
              sourcePolicyRevision: 1,
              predecessor: null,
              canonicalPostState: { taskId: 'task-same-source', suffix },
              statements: [
                {
                  sql: `INSERT INTO workshop_concurrent_sources(
                          source_kind, source_id, event_id
                        ) VALUES ('task', 'task-same-source', ?)`,
                  values: [`same-source-event-${suffix}`],
                },
              ],
            }),
          ),
        );
        const race = await Promise.allSettled(
          sameSourceHandles.map((handle) =>
            producers.task.guard.commitCanonicalMutation(handle),
          ),
        );
        expect(
          race.filter(({ status }) => status === 'fulfilled'),
        ).toHaveLength(1);
        const rejected = race.find(({ status }) => status === 'rejected');
        expect(rejected?.status).toBe('rejected');
        if (!rejected || rejected.status !== 'rejected')
          throw new Error('same-source race did not reject one commit');
        expect(rejected.reason).toBeInstanceOf(InvalidAuthorizationError);
        expect(String(rejected.reason)).not.toMatch(/internal_error/u);
        expect(
          await scalar(
            env.db,
            `SELECT COUNT(*) FROM taproot_unified_search_source_events
             WHERE source_kind='task' AND source_id='task-same-source'`,
          ),
        ).toBe(1);

        const generationBeforeFailure = await scalar(
          env.db,
          `SELECT search_generation FROM taproot_installation_authorization
           WHERE singleton = 1`,
        );
        const failing =
          await producers.memory.coordinator.sealCanonicalMutation({
            context: producerContext('memory'),
            eventId: 'concurrent-domain-failure',
            sourceId: 'memory-domain-failure',
            operation: 'upsert',
            changeClass: 'canonical',
            sourceRevision: '1',
            sourcePolicyRevision: 1,
            predecessor: null,
            canonicalPostState: { memoryId: 'memory-domain-failure' },
            statements: [
              {
                sql: `INSERT INTO workshop_concurrent_sources(
                        source_kind, source_id, event_id
                      ) VALUES ('task', 'task-same-source', 'duplicate')`,
                values: [],
              },
            ],
          });
        await expect(
          producers.memory.guard.commitCanonicalMutation(failing),
        ).rejects.toThrow();
        expect(
          await scalar(
            env.db,
            `SELECT COUNT(*) FROM taproot_unified_search_source_events
             WHERE event_id='concurrent-domain-failure'`,
          ),
        ).toBe(0);
        expect(
          await scalar(
            env.db,
            `SELECT search_generation FROM taproot_installation_authorization
             WHERE singleton = 1`,
          ),
        ).toBe(generationBeforeFailure);
      } finally {
        await env.close();
      }
    }, 60_000);

    it('rejects cross-kind handles and Taproot SQL at the bound preparer', async () => {
      const env = await runtime.create();
      try {
        const task = await producer(env.db, env.capability, 'task', 'b');
        const memory = await producer(env.db, env.capability, 'memory', 'c');
        const taskHandle = await task.coordinator.sealCanonicalMutation({
          context: taskContext(),
          eventId: 'cross-task-1',
          sourceId: 'task-cross',
          operation: 'upsert',
          changeClass: 'canonical',
          sourceRevision: '1',
          sourcePolicyRevision: 1,
          predecessor: null,
          canonicalPostState: { taskId: 'task-cross', revision: 1 },
          statements: [{ sql: `SELECT ?`, values: [1] }],
        });
        await expect(
          memory.guard.commitCanonicalMutation(taskHandle),
        ).rejects.toBeInstanceOf(InvalidAuthorizationError);
        await expect(
          task.coordinator.sealCanonicalMutation({
            context: taskContext(),
            eventId: 'forbidden-sql',
            sourceId: 'task-forbidden',
            operation: 'upsert',
            changeClass: 'canonical',
            sourceRevision: '1',
            sourcePolicyRevision: 1,
            predecessor: null,
            canonicalPostState: { taskId: 'task-forbidden' },
            statements: [
              {
                sql: `UPDATE taproot_installation_authorization
                      SET search_generation = 99`,
                values: [],
              },
            ],
          }),
        ).rejects.toBeInstanceOf(InvalidAuthorizationError);
      } finally {
        await env.close();
      }
    }, 30_000);
  });
}

async function producer(
  db: D1DatabaseLike,
  capability: TaprootHostWriteCapability,
  sourceKind: 'task' | 'memory' | 'prompt',
  fingerprintCharacter: string,
  callbackOverrides: Partial<ExternalSearchProducerCallbacksV1> = {},
) {
  const binding = {
    domain: 'workshop',
    sourceKind,
    capability: `${sourceKind}:write`,
    changeClasses: ['canonical', 'authorization', 'eligibility'],
  } as const;
  const coordinator = await createExternalSearchDomainMutationCoordinatorV1(
    db,
    options,
    capability,
    binding,
  );
  const authority = await createExternalSearchDomainPolicyAuthorityV1(
    db,
    options,
    capability,
    binding,
  );
  const callbacks: ExternalSearchProducerCallbacksV1 = {
    enumerateLegacyCurrent: () =>
      Promise.resolve({ sourceIds: [], nextCursor: null }),
    loadCurrent: () => Promise.resolve(null),
    projectCurrent: () =>
      Promise.resolve({
        version: 1,
        documents: [],
        replaceAll: true,
        removeDocumentSlots: [],
      }),
    authorizeCurrentReference: (_authority, input) =>
      Promise.resolve({
        version: 1,
        ...input,
        workspaceId: 'workspace-1',
        ownerPrincipalId: 'workshop-agent',
        visibility: { version: 1, clauses: [] },
      }),
    hydrateCurrentReference: () => Promise.resolve({ version: 1 }),
    ...callbackOverrides,
  };
  const guard = await createExternalSearchProducerGuardV1(
    db,
    options,
    capability,
    {
      version: 1,
      sourceKind,
      owningDomain: 'workshop',
      producerFingerprint: fingerprintCharacter.repeat(64),
      contractVersion: 'workshop-search-producer-v1',
      projectionVersion: 'workshop-search-projection-v1',
      authorizationContractVersion: 'workshop-search-authorization-v1',
    },
    callbacks,
    authority,
    coordinator,
  );
  return { coordinator, guard };
}

function pagedCallbacks(): Partial<ExternalSearchProducerCallbacksV1> {
  return {
    enumerateLegacyCurrent: ({ cursor }) =>
      Promise.resolve(
        cursor === null
          ? { sourceIds: [], nextCursor: 'page-2' }
          : { sourceIds: [], nextCursor: null },
      ),
  };
}

function taskContext(): AuthorizationContext {
  return {
    installationId,
    principalId: 'workshop-agent',
    activeWorkspaceId: 'workspace-1',
    workspaceIds: ['workspace-1'],
    capabilities: ['task:write'],
    authorizationRevision: 1,
  };
}

function producerContext(
  kind: 'task' | 'memory' | 'prompt',
): AuthorizationContext {
  return {
    ...taskContext(),
    capabilities: [`${kind}:write`],
  };
}

function adminContext(): AuthorizationContext {
  return {
    ...taskContext(),
    capabilities: ['search:admin'],
  };
}

async function environment(db: D1DatabaseLike, close: () => Promise<void>) {
  await applyTaprootMigrations(db, options);
  const key = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const capability = createTaprootHostWriteCapability(db, options, key);
  await bootstrapTaprootAuthorization(db, options, capability, installationId);
  return { db, capability, close };
}

async function reconstructedEnvironment(
  db: D1DatabaseLike,
  close: () => Promise<void>,
) {
  await applyTaprootMigrations(db, options);
  const key = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return {
    db,
    capability: createTaprootHostWriteCapability(db, options, key),
    close,
  };
}

function nodeRuntime() {
  return {
    name: 'persisted Node SQLite',
    async create() {
      const directory = mkdtempSync(join(tmpdir(), 'taproot-external-node-'));
      temporaryDirectories.push(directory);
      const path = join(directory, 'taproot.sqlite');
      const db = new NodeSqliteDatabase(path);
      return {
        ...(await environment(db, () => db.close())),
        async reopen() {
          const reopened = new NodeSqliteDatabase(path);
          return reconstructedEnvironment(reopened, () => reopened.close());
        },
      };
    },
  };
}

function workerdRuntime() {
  return {
    name: 'persisted Workerd D1',
    async create() {
      const directory = mkdtempSync(join(tmpdir(), 'taproot-external-d1-'));
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
        ...(await environment(db, () => miniflare.dispose())),
        async reopen() {
          const reopenedMiniflare = createMiniflare();
          const reopened = (await reopenedMiniflare.getD1Database(
            'DB',
          )) as unknown as D1DatabaseLike;
          return reconstructedEnvironment(reopened, () =>
            reopenedMiniflare.dispose(),
          );
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
