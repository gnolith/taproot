import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  D1DatabaseLike,
  SqlitePreparedStatementLike,
  SqliteResultLike,
} from '@gnolith/diamond';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_POLICY_CAPABILITY,
  KNOWLEDGE_WRITE_CAPABILITY,
  SEARCH_ADMIN_CAPABILITY,
  TaprootMigrationStateError,
  bootstrapTaprootAuthorization,
  applyTaprootMigrations,
  createInstallationAuthorizationGuard,
  createInstallationSearchSourceGuardV1,
  createItem,
  createProperty,
  createSearchMaterializationAdminGuardV1,
  createStatement,
  createTaprootHostWriteCapability,
  initializeTaproot,
  inspectTaprootSchema,
  planTaprootMigrations,
  removeStatement,
  restoreEntity,
  setLabel,
  softDeleteEntity,
  taprootSearchMaterializationSchemaStatements,
  taprootSearchSourceEventSchemaStatements,
  taprootExternalSearchProducerSchemaStatements,
  type AuthorizationContext,
  type CanonicalAuthorizationPolicyInput,
  type TaprootHostWriteCapability,
  type VisibilityScopeV1,
} from '../src/index.js';

const options = { baseIri: 'https://materialization.example' };
const installationId = 'installation-materialization-1';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const scope: VisibilityScopeV1 = {
  version: 1,
  clauses: [
    [
      { kind: 'workspace', workspaceId: 'workspace-1' },
      { kind: 'principal', principalId: 'principal-1' },
    ],
    [{ kind: 'capability', capability: KNOWLEDGE_WRITE_CAPABILITY }],
  ],
};

for (const runtime of [nodeRuntime(), workerdRuntime()]) {
  describe(`persisted search materialization on ${runtime.name}`, () => {
    it('applies exact DDL-only 0005 to 0006 without source-event backfill', async () => {
      const env = await runtime.create();
      try {
        await bootstrapTaprootAuthorization(
          env.db,
          options,
          env.capability,
          installationId,
        );
        const guard = await createInstallationAuthorizationGuard(
          env.db,
          options,
          env.capability,
        );
        await createItem(env.db, options, guard, writeContext(1), {
          id: 'Q1',
          authorization: policy(1, {}),
        });
        await downgradeTo0005(env.db);
        expect(await planTaprootMigrations(env.db)).toMatchObject([
          { id: '0001-v0.1-schema', status: 'applied' },
          { id: '0002-durable-database-identity', status: 'applied' },
          { id: '0003-canonical-statement-text', status: 'applied' },
          { id: '0004-canonical-authorization-policy', status: 'applied' },
          { id: '0005-unified-search-source-events', status: 'applied' },
          {
            id: '0006-unified-search-materialization-lifecycle',
            status: 'pending',
          },
          { id: '0007-external-search-producers', status: 'pending' },
        ]);
        await applyTaprootMigrations(env.db, options);
        expect((await inspectTaprootSchema(env.db)).valid).toBe(true);
        expect(await count(env.db, 'taproot_search_projection_jobs')).toBe(0);
        expect(await count(env.db, 'taproot_search_installation_state')).toBe(
          0,
        );
      } finally {
        await env.close();
      }
    }, 30_000);

    it('fans out, claims once, replaces the complete Item+Statement root, and preserves stable document identity', async () => {
      const env = await runtime.create();
      try {
        await bootstrapTaprootAuthorization(
          env.db,
          options,
          env.capability,
          installationId,
        );
        const materialization = await createSearchMaterializationAdminGuardV1(
          env.db,
          options,
          env.capability,
        );
        await materialization.initialize(adminContext(1));
        const guard = await createInstallationAuthorizationGuard(
          env.db,
          options,
          env.capability,
        );
        await createProperty(env.db, options, guard, writeContext(1), {
          id: 'P1',
          datatype: 'string',
          authorization: policy(1, {}),
        });
        const first = createStatement(
          'Q1',
          {
            snaktype: 'value',
            property: 'P1',
            datatype: 'string',
            datavalue: { type: 'string', value: 'one' },
          },
          'first authored statement',
          { id: 'Q1$first' },
        );
        const second = createStatement(
          'Q1',
          {
            snaktype: 'value',
            property: 'P1',
            datatype: 'string',
            datavalue: { type: 'string', value: 'two' },
          },
          'second authored statement',
          { id: 'Q1$second' },
        );
        await createItem(env.db, options, guard, writeContext(2), {
          id: 'Q1',
          labels: { en: { language: 'en', value: 'Kiln' } },
          claims: { P1: [first, second] },
          authorization: policy(2, { [first.id]: [], [second.id]: [] }),
        });
        expect(await count(env.db, 'taproot_search_projection_jobs')).toBe(1);
        await env.db
          .prepare(
            `UPDATE taproot_search_projection_jobs
               SET state = 'staged', claim_token = ?, claim_generation = 1,
                   lease_expires_at = '2020-01-01T00:00:00.000Z'
               WHERE source_id = 'Q1'`,
          )
          .bind('0'.repeat(32))
          .run();
        await env.db
          .prepare(
            `INSERT INTO taproot_search_stages(
                 stage_id, job_id, corpus_id, claim_token, claim_generation,
                 state, root_kind, root_id, source_event_id,
                 source_event_sequence, root_revision, root_hash,
                 authorization_revision, created_at
               )
               SELECT 'crashed-stage', job_id, corpus_id, claim_token,
                 claim_generation, 'building', source_kind, source_id,
                 source_event_id, source_event_sequence, root_revision,
                 root_hash, authorization_revision,
                 '2020-01-01T00:00:00.000Z'
               FROM taproot_search_projection_jobs WHERE source_id = 'Q1'`,
          )
          .run();
        const attempts = await Promise.all(
          Array.from({ length: 32 }, () =>
            materialization.run(adminContext(3), runOptions()),
          ),
        );
        expect(attempts.reduce((sum, result) => sum + result.claimed, 0)).toBe(
          1,
        );
        expect(
          attempts.reduce((sum, result) => sum + result.completed, 0),
        ).toBe(1);
        const staleAba = await env.db
          .prepare(
            `UPDATE taproot_search_projection_jobs SET state = 'dead'
               WHERE source_id = 'Q1' AND claim_token = ?
                 AND claim_generation = 1`,
          )
          .bind('0'.repeat(32))
          .run();
        expect(Number(staleAba.meta?.changes ?? 0)).toBe(0);
        const crashed = await env.db
          .prepare(
            `SELECT state FROM taproot_search_stages
               WHERE stage_id = 'crashed-stage'`,
          )
          .all<{ state: string }>();
        expect(crashed.results[0]?.state).toBe('abandoned');
        const firstStage = await visibleDocuments(env.db);
        expect(firstStage.map(({ document_slot }) => document_slot)).toEqual([
          'item',
          'statement:Q1$first',
          'statement:Q1$second',
        ]);
        expect(
          firstStage.map(({ document_id }) => new Set([document_id]).size),
        ).toEqual([1, 1, 1]);
        expect(await count(env.db, 'taproot_search_document_clauses')).toBe(6);
        expect(await count(env.db, 'taproot_search_document_atoms')).toBe(9);
        expect(
          await count(env.db, 'taproot_search_filter_values'),
        ).toBeGreaterThan(3);

        await setLabel(
          env.db,
          options,
          guard,
          writeContext(3),
          'Q1',
          'en',
          'Kiln revised',
          {
            expectedRevision: 1,
            authorization: policy(3, { [first.id]: [], [second.id]: [] }),
          },
        );
        expect(await activeEligibility(env.db)).toBe(0);
        await materialization.run(adminContext(4), runOptions());
        const secondStage = await visibleDocuments(env.db);
        expect(secondStage.map(({ document_id }) => document_id)).toEqual(
          firstStage.map(({ document_id }) => document_id),
        );
        expect(
          secondStage.find(({ document_slot }) => document_slot === 'item')
            ?.document_text,
        ).toContain('Kiln revised');

        await removeStatement(
          env.db,
          options,
          guard,
          writeContext(4),
          'Q1',
          first.id,
          {
            expectedRevision: 2,
            authorization: policy(4, { [second.id]: [] }),
          },
        );
        expect(await activeEligibility(env.db)).toBe(0);
        await materialization.run(adminContext(5), runOptions());
        expect(
          (await visibleDocuments(env.db)).map(
            ({ document_slot }) => document_slot,
          ),
        ).toEqual(['item', 'statement:Q1$second']);
        expect(
          await count(env.db, 'taproot_search_materialization_tombstones'),
        ).toBe(2);

        await softDeleteEntity(env.db, options, guard, writeContext(5), 'Q1', {
          expectedRevision: 3,
          authorization: policy(5, { [second.id]: [] }),
        });
        expect(await activeEligibility(env.db)).toBe(0);
        await materialization.run(adminContext(6), runOptions());
        expect(await visibleDocuments(env.db)).toEqual([]);

        await restoreEntity(env.db, options, guard, writeContext(6), 'Q1', {
          expectedRevision: 4,
          authorization: policy(6, { [second.id]: [] }),
        });
        expect(await activeEligibility(env.db)).toBe(0);
        await materialization.run(adminContext(7), runOptions());
        expect(
          (await visibleDocuments(env.db)).map(
            ({ document_slot }) => document_slot,
          ),
        ).toEqual(['item', 'statement:Q1$second']);
        expect(
          await count(env.db, 'taproot_search_materialization_tombstones'),
        ).toBe(4);

        const health = await materialization.health(adminContext(7));
        expect(health).toMatchObject({
          version: 1,
          status: 'blocked',
          blockedProducerKinds: [
            'task',
            'memory',
            'prompt',
            'resource',
            'annotation',
          ],
          pendingJobs: 0,
          deadJobs: 0,
          staleHeads: 0,
        });
        expect(JSON.stringify(health)).not.toMatch(
          /Kiln|statement|claim_token|document_text/u,
        );
      } finally {
        await env.close();
      }
    }, 75_000);

    it('builds and atomically activates a no-hole shadow while dual fanout captures concurrent mutation', async () => {
      const env = await runtime.create();
      try {
        await bootstrapTaprootAuthorization(
          env.db,
          options,
          env.capability,
          installationId,
        );
        const materialization = await createSearchMaterializationAdminGuardV1(
          env.db,
          options,
          env.capability,
        );
        await materialization.initialize(adminContext(1));
        const guard = await createInstallationAuthorizationGuard(
          env.db,
          options,
          env.capability,
        );
        await createItem(env.db, options, guard, writeContext(1), {
          id: 'Q1',
          labels: { en: { language: 'en', value: 'before rebuild' } },
          authorization: policy(1, {}),
        });
        await materialization.run(adminContext(2), runOptions());
        await env.db
          .prepare(
            `CREATE TABLE rebuild_statement_probe(id TEXT PRIMARY KEY) STRICT`,
          )
          .run();
        const statementSource = await createInstallationSearchSourceGuardV1(
          env.db,
          options,
          env.capability,
          {
            domain: 'taproot.statement-probe',
            sourceKind: 'statement',
            capability: 'statement-write',
            changeClasses: ['canonical'],
          },
        );
        await statementSource.batchWithSourceEvent(
          {
            installationId,
            principalId: 'statement-producer',
            activeWorkspaceId: null,
            workspaceIds: [],
            capabilities: ['statement-write'],
            authorizationRevision: 2,
          },
          {
            eventId: 'rebuild-statement-event',
            sourceId: 'Q1$rebuild-statement',
            operation: 'upsert',
            changeClass: 'canonical',
            sourceRevision: '1',
            sourceHash: 'e'.repeat(64),
            predecessor: null,
          },
          [
            env.db.prepare(
              `INSERT INTO rebuild_statement_probe(id) VALUES ('statement')`,
            ),
          ],
        );
        expect(
          (await materialization.run(adminContext(2), runOptions())).superseded,
        ).toBe(1);
        expect(await materialization.startShadowRebuild(adminContext(2))).toBe(
          2,
        );
        await setLabel(
          env.db,
          options,
          guard,
          writeContext(2),
          'Q1',
          'en',
          'during rebuild',
          { expectedRevision: 1, authorization: policy(2, {}) },
        );
        for (let index = 0; index < 5; index += 1)
          await materialization.run(adminContext(3), runOptions());
        expect(await materialization.activateReadyShadow(adminContext(3))).toBe(
          2,
        );
        const state = await env.db
          .prepare(
            `SELECT cursor_generation, shadow_corpus_id
               FROM taproot_search_installation_state`,
          )
          .all<{
            cursor_generation: number;
            shadow_corpus_id: string | null;
          }>();
        expect(state.results[0]).toEqual({
          cursor_generation: 2,
          shadow_corpus_id: null,
        });
        expect((await visibleDocuments(env.db))[0]?.document_text).toContain(
          'during rebuild',
        );
      } finally {
        await env.close();
      }
    }, 45_000);

    it('rejects a stale finalize when delete and authorization advance inside the publication window', async () => {
      const env = await runtime.create();
      try {
        const db = new InterceptingDatabase(env.db);
        const capability = await hostCapability(db);
        await bootstrapTaprootAuthorization(
          db,
          options,
          capability,
          installationId,
        );
        const materialization = await createSearchMaterializationAdminGuardV1(
          db,
          options,
          capability,
        );
        await materialization.initialize(adminContext(1));
        const guard = await createInstallationAuthorizationGuard(
          db,
          options,
          capability,
        );
        await createItem(db, options, guard, writeContext(1), {
          id: 'Q1',
          labels: { en: { language: 'en', value: 'must not publish' } },
          authorization: policy(1, {}),
        });
        db.intercept(
          /INSERT INTO taproot_search_materialization_heads/iu,
          async () => {
            await softDeleteEntity(db, options, guard, writeContext(2), 'Q1', {
              expectedRevision: 1,
              authorization: policy(2, {}),
            });
          },
        );
        const stale = await materialization.run(adminContext(2), runOptions());
        expect(stale).toMatchObject({ completed: 0, deferred: 1 });
        expect(await count(db, 'taproot_search_materialization_heads')).toBe(0);
        expect(await visibleDocuments(db)).toEqual([]);

        const deletion = await materialization.run(
          adminContext(3),
          runOptions(),
        );
        expect(deletion.completed).toBe(1);
        expect(await activeEligibility(db)).toBe(0);
        expect(await visibleDocuments(db)).toEqual([]);
      } finally {
        await env.close();
      }
    }, 45_000);

    it('revokes ready shadow state and rejects activation when a source advances inside the activation window', async () => {
      const env = await runtime.create();
      try {
        const db = new InterceptingDatabase(env.db);
        const capability = await hostCapability(db);
        await bootstrapTaprootAuthorization(
          db,
          options,
          capability,
          installationId,
        );
        const materialization = await createSearchMaterializationAdminGuardV1(
          db,
          options,
          capability,
        );
        await materialization.initialize(adminContext(1));
        const guard = await createInstallationAuthorizationGuard(
          db,
          options,
          capability,
        );
        await createItem(db, options, guard, writeContext(1), {
          id: 'Q1',
          labels: { en: { language: 'en', value: 'before activation race' } },
          authorization: policy(1, {}),
        });
        await materialization.run(adminContext(2), runOptions());
        await materialization.startShadowRebuild(adminContext(2));
        await materialization.run(adminContext(2), runOptions());
        db.intercept(/SET active_corpus_id = shadow_corpus_id/iu, async () => {
          await setLabel(
            db,
            options,
            guard,
            writeContext(2),
            'Q1',
            'en',
            'inside activation race',
            { expectedRevision: 1, authorization: policy(2, {}) },
          );
        });
        await expect(
          materialization.activateReadyShadow(adminContext(2)),
        ).rejects.toThrow();
        const interrupted = await db
          .prepare(
            `SELECT s.shadow_corpus_id, c.state
             FROM taproot_search_installation_state s
             JOIN taproot_search_corpora c ON c.corpus_id = s.shadow_corpus_id`,
          )
          .all<{ shadow_corpus_id: string | null; state: string }>();
        expect(interrupted.results[0]?.shadow_corpus_id).not.toBeNull();
        expect(interrupted.results[0]?.state).toBe('building');

        await materialization.run(adminContext(3), runOptions());
        expect(await materialization.activateReadyShadow(adminContext(3))).toBe(
          2,
        );
        expect((await visibleDocuments(db))[0]?.document_text).toContain(
          'inside activation race',
        );
      } finally {
        await env.close();
      }
    }, 60_000);

    it('leaves unavailable producer jobs unattempted, reports dynamic health, and coalesces standalone Statements', async () => {
      const env = await runtime.create();
      try {
        const fixedOptions = {
          ...options,
          clock: () => new Date('2026-07-22T12:00:00.000Z'),
        };
        await bootstrapTaprootAuthorization(
          env.db,
          fixedOptions,
          env.capability,
          installationId,
        );
        const materialization = await createSearchMaterializationAdminGuardV1(
          env.db,
          fixedOptions,
          env.capability,
        );
        await materialization.initialize(adminContext(1));
        await env.db
          .prepare(
            `UPDATE taproot_unified_search_generation_producers
             SET state = 'ready', producer_fingerprint = ?,
                 contract_version = 'workshop-search-producer-v1',
                 projection_version = 'workshop-search-projection-v1',
                 authorization_contract_version = 'workshop-search-authorization-v1'
             WHERE installation_id = ? AND source_kind = 'task'`,
          )
          .bind('a'.repeat(64), installationId)
          .run();
        await env.db
          .prepare(`CREATE TABLE producer_probe(id TEXT PRIMARY KEY) STRICT`)
          .run();
        const taskSource = await createInstallationSearchSourceGuardV1(
          env.db,
          fixedOptions,
          env.capability,
          {
            domain: 'workshop.task',
            sourceKind: 'task',
            capability: 'task-write',
            changeClasses: ['canonical'],
          },
        );
        const producerContext: AuthorizationContext = {
          installationId,
          principalId: 'producer-1',
          activeWorkspaceId: 'workspace-1',
          workspaceIds: ['workspace-1'],
          capabilities: ['task-write'],
          authorizationRevision: 1,
        };
        await taskSource.batchWithSourceEvent(
          producerContext,
          {
            eventId: 'task-event-1',
            sourceId: 'task-1',
            operation: 'upsert',
            changeClass: 'canonical',
            sourceRevision: '1',
            sourceHash: 'a'.repeat(64),
            predecessor: null,
          },
          [
            env.db.prepare(
              `INSERT INTO producer_probe(id) VALUES ('task-event-1')`,
            ),
          ],
        );
        await taskSource.batchWithSourceEvent(
          producerContext,
          {
            eventId: 'task-event-2',
            sourceId: 'task-2',
            operation: 'upsert',
            changeClass: 'canonical',
            sourceRevision: '1',
            sourceHash: 'd'.repeat(64),
            predecessor: null,
          },
          [
            env.db.prepare(
              `INSERT INTO producer_probe(id) VALUES ('task-event-2')`,
            ),
          ],
        );
        const unavailable = await materialization.run(
          adminContext(1),
          runOptions(),
        );
        expect(unavailable).toMatchObject({
          claimed: 0,
          deferred: 0,
          dead: 0,
        });
        const untouched = await env.db
          .prepare(
            `SELECT state, attempt FROM taproot_search_projection_jobs
             WHERE source_kind = 'task' ORDER BY source_id`,
          )
          .all<{ state: string; attempt: number }>();
        expect(untouched.results).toEqual([
          { state: 'pending', attempt: 0 },
          { state: 'pending', attempt: 0 },
        ]);
        const unavailableHealth = await materialization.health(adminContext(1));
        expect(unavailableHealth).toMatchObject({
          status: 'blocked',
          pendingJobs: 2,
          deadJobs: 0,
        });
        expect(unavailableHealth.blockedProducerKinds).toContain('task');

        const statementSource = await createInstallationSearchSourceGuardV1(
          env.db,
          fixedOptions,
          env.capability,
          {
            domain: 'taproot.statement-probe',
            sourceKind: 'statement',
            capability: 'statement-write',
            changeClasses: ['canonical'],
          },
        );
        await statementSource.batchWithSourceEvent(
          { ...producerContext, capabilities: ['statement-write'] },
          {
            eventId: 'statement-event-1',
            sourceId: 'Q1$statement-1',
            operation: 'upsert',
            changeClass: 'canonical',
            sourceRevision: '1',
            sourceHash: 'b'.repeat(64),
            predecessor: null,
          },
          [
            env.db.prepare(
              `INSERT INTO producer_probe(id) VALUES ('statement-event-1')`,
            ),
          ],
        );
        const coalesced = await materialization.run(
          adminContext(1),
          runOptions(),
        );
        expect(coalesced.superseded).toBe(1);
        expect(
          await env.db
            .prepare(
              `SELECT COUNT(*) AS count FROM taproot_search_job_transitions
               WHERE error_code = 'item-root-owned'`,
            )
            .all<{ count: number }>(),
        ).toMatchObject({ results: [{ count: 1 }] });
      } finally {
        await env.close();
      }
    }, 60_000);

    it('prevents an expired claimant from appending a false immutable transition after reclaim', async () => {
      const env = await runtime.create();
      try {
        const db = new InterceptingDatabase(env.db);
        const capability = await hostCapability(db);
        let now = new Date('2026-07-22T12:00:00.000Z');
        const timedOptions = { ...options, clock: () => now };
        await bootstrapTaprootAuthorization(
          db,
          timedOptions,
          capability,
          installationId,
        );
        const materialization = await createSearchMaterializationAdminGuardV1(
          db,
          timedOptions,
          capability,
        );
        await materialization.initialize(adminContext(1));
        const guard = await createInstallationAuthorizationGuard(
          db,
          timedOptions,
          capability,
        );
        await createItem(db, timedOptions, guard, writeContext(1), {
          id: 'Q999',
          authorization: policy(1, {}),
        });
        await db
          .prepare(
            `UPDATE taproot_entities SET entity_json = '{}'
             WHERE entity_id = 'Q999'`,
          )
          .run();
        db.intercept(
          /SELECT \?, job_id, state, \?, attempt,[\s\S]*state IN \('leased', 'staged'\)/iu,
          async () => {
            now = new Date(now.getTime() + 60_000);
            const reclaimed = await materialization.run(adminContext(1), {
              ...runOptions(),
              leaseMilliseconds: 1_000,
            });
            expect(reclaimed.deferred).toBe(1);
          },
        );
        await expect(
          materialization.run(adminContext(1), {
            ...runOptions(),
            leaseMilliseconds: 1_000,
          }),
        ).rejects.toThrow();
        const state = await db
          .prepare(
            `SELECT state, claim_generation FROM taproot_search_projection_jobs
             WHERE claim_generation = (
               SELECT MAX(claim_generation) FROM taproot_search_projection_jobs
             )
             ORDER BY claim_generation DESC LIMIT 1`,
          )
          .all<{ state: string; claim_generation: number }>();
        expect(state.results[0]).toEqual({
          state: 'pending',
          claim_generation: 0,
        });
        const transitions = await db
          .prepare(
            `SELECT transition_id FROM taproot_search_job_transitions
             WHERE transition_id LIKE '%:pending:%' ORDER BY transition_id`,
          )
          .all<{ transition_id: string }>();
        expect(
          transitions.results.map(({ transition_id }) => transition_id),
        ).toEqual([]);
      } finally {
        await env.close();
      }
    }, 45_000);
  });
}

describe('materialization migration drift refusal', () => {
  it('recovers queued materialization work after a persisted Node process restart', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'taproot-materialization-restart-'),
    );
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'taproot.sqlite');
    const firstDatabase = new NodeSqliteDatabase(databasePath);
    await initializeTaproot(firstDatabase, options);
    const first = await environment(firstDatabase, () => firstDatabase.close());
    await bootstrapTaprootAuthorization(
      first.db,
      options,
      first.capability,
      installationId,
    );
    const firstMaterialization = await createSearchMaterializationAdminGuardV1(
      first.db,
      options,
      first.capability,
    );
    await firstMaterialization.initialize(adminContext(1));
    const firstGuard = await createInstallationAuthorizationGuard(
      first.db,
      options,
      first.capability,
    );
    await createItem(first.db, options, firstGuard, writeContext(1), {
      id: 'Q1',
      labels: { en: { language: 'en', value: 'survives restart' } },
      authorization: policy(1, {}),
    });
    await first.close();

    const reopenedDatabase = new NodeSqliteDatabase(databasePath);
    const reopened = await environment(reopenedDatabase, () =>
      reopenedDatabase.close(),
    );
    try {
      const materialization = await createSearchMaterializationAdminGuardV1(
        reopened.db,
        options,
        reopened.capability,
      );
      const receipt = await materialization.run(adminContext(2), runOptions());
      expect(receipt).toMatchObject({ claimed: 1, completed: 1 });
      expect((await visibleDocuments(reopened.db))[0]?.document_text).toContain(
        'survives restart',
      );
    } finally {
      await reopened.close();
    }
  });

  it('pins 100k roots and one million chunks with indexed bounded paths and no SLA', () => {
    const artifact = JSON.parse(
      readFileSync('benchmarks/search-materialization-100k.json', 'utf8'),
    ) as {
      workload: {
        roots: number;
        documents: number;
        chunks: number;
        claimJobs: { pending: number; leased: number; staged: number };
      };
      result: {
        roots: number;
        chunks: number;
        queryPlans: Record<string, string>;
      };
      sla: unknown;
    };
    expect(artifact.workload).toEqual({
      roots: 100_000,
      documents: 100_000,
      chunks: 1_000_000,
      claimJobs: { pending: 25_000, leased: 25_000, staged: 25_000 },
    });
    expect(artifact.result).toMatchObject({
      roots: 100_000,
      chunks: 1_000_000,
    });
    expect(Object.keys(artifact.result.queryPlans)).toEqual([
      'visible',
      'antiJoin',
      'claimPending',
      'claimExpiredLeased',
      'claimExpiredStaged',
    ]);
    expect(artifact.result.queryPlans.visible).toContain(
      'taproot_search_heads_eligibility_idx',
    );
    expect(artifact.result.queryPlans.antiJoin).toContain(
      'taproot_search_source_registry_lookup_idx',
    );
    expect(artifact.result.queryPlans.claimPending).toContain(
      'taproot_search_jobs_claim_pending_idx',
    );
    expect(artifact.result.queryPlans.claimExpiredLeased).toContain(
      'taproot_search_jobs_claim_lease_idx',
    );
    expect(artifact.result.queryPlans.claimExpiredStaged).toContain(
      'taproot_search_jobs_claim_lease_idx',
    );
    expect(
      Object.values(artifact.result.queryPlans).every((plan) =>
        plan.includes('INDEX'),
      ),
    ).toBe(true);
    expect(
      Object.values(artifact.result.queryPlans).every(
        (plan) => !plan.includes('TEMP B-TREE'),
      ),
    ).toBe(true);
    expect(artifact.sla).toBeNull();
  });

  it('does not stamp 0006 over a drifted exact-0005 predecessor', async () => {
    const env = await nodeRuntime().create();
    try {
      await downgradeTo0005(env.db);
      await env.db
        .prepare(`DROP INDEX taproot_search_source_events_sequence_idx`)
        .run();
      await expect(
        applyTaprootMigrations(env.db, options),
      ).rejects.toBeInstanceOf(TaprootMigrationStateError);
      expect(
        await migrationCount(
          env.db,
          '0006-unified-search-materialization-lifecycle',
        ),
      ).toBe(0);
    } finally {
      await env.close();
    }
  });

  it('fails operational inspection when a materialization table drifts', async () => {
    const env = await nodeRuntime().create();
    try {
      await env.db
        .prepare(`ALTER TABLE taproot_search_corpora ADD COLUMN drift TEXT`)
        .run();
      const inspection = await inspectTaprootSchema(env.db);
      expect(inspection.valid).toBe(false);
      expect(inspection.errors).toContain(
        'taproot_search_corpora definition does not match the package catalog',
      );
    } finally {
      await env.close();
    }
  });
});

class InterceptingStatement implements SqlitePreparedStatementLike {
  constructor(
    readonly sql: string,
    readonly inner: SqlitePreparedStatementLike,
  ) {}

  bind(...values: unknown[]): InterceptingStatement {
    return new InterceptingStatement(this.sql, this.inner.bind(...values));
  }

  run<T = Record<string, unknown>>(): Promise<SqliteResultLike<T>> {
    return this.inner.run<T>();
  }

  all<T = Record<string, unknown>>(): Promise<SqliteResultLike<T>> {
    return this.inner.all<T>();
  }
}

class InterceptingDatabase implements D1DatabaseLike {
  #pattern: RegExp | null = null;
  #callback: (() => Promise<void>) | null = null;

  constructor(private readonly inner: D1DatabaseLike) {}

  intercept(pattern: RegExp, callback: () => Promise<void>): void {
    this.#pattern = pattern;
    this.#callback = callback;
  }

  prepare(sql: string): InterceptingStatement {
    return new InterceptingStatement(sql, this.inner.prepare(sql));
  }

  async batch<T = Record<string, unknown>>(
    statements: SqlitePreparedStatementLike[],
  ): Promise<Array<SqliteResultLike<T>>> {
    const tracked = statements.map((statement) => {
      if (!(statement instanceof InterceptingStatement))
        throw new Error('expected an intercepted statement');
      return statement;
    });
    if (
      this.#pattern &&
      this.#callback &&
      tracked.some(({ sql }) => this.#pattern!.test(sql))
    ) {
      const callback = this.#callback;
      this.#pattern = null;
      this.#callback = null;
      await callback();
    }
    return this.inner.batch<T>(tracked.map(({ inner }) => inner));
  }
}

function nodeRuntime() {
  return {
    name: 'persisted Node SQLite',
    async create() {
      const directory = mkdtempSync(join(tmpdir(), 'taproot-materialization-'));
      temporaryDirectories.push(directory);
      const db = new NodeSqliteDatabase(join(directory, 'taproot.sqlite'));
      await initializeTaproot(db, options);
      return environment(db, () => db.close());
    },
  };
}

function workerdRuntime() {
  return {
    name: 'real Workerd D1',
    async create() {
      const miniflare = new Miniflare({
        modules: true,
        script: 'export default { fetch() { return new Response("ok") } }',
        compatibilityDate: '2026-07-19',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: crypto.randomUUID() },
      });
      const db = (await miniflare.getD1Database(
        'DB',
      )) as unknown as D1DatabaseLike;
      await initializeTaproot(db, options);
      return environment(db, () => miniflare.dispose());
    },
  };
}

async function environment(db: D1DatabaseLike, close: () => Promise<void>) {
  return {
    db,
    capability: await hostCapability(db),
    close,
  } satisfies {
    db: D1DatabaseLike;
    capability: TaprootHostWriteCapability;
    close(): Promise<void>;
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

function writeContext(revision: number): AuthorizationContext {
  return {
    installationId,
    principalId: 'principal-1',
    activeWorkspaceId: 'workspace-1',
    workspaceIds: ['workspace-1'],
    capabilities: [KNOWLEDGE_WRITE_CAPABILITY, KNOWLEDGE_POLICY_CAPABILITY],
    authorizationRevision: revision,
  };
}

function adminContext(revision: number): AuthorizationContext {
  return {
    ...writeContext(revision),
    capabilities: [SEARCH_ADMIN_CAPABILITY],
  };
}

function policy(
  expectedAuthorizationRevision: number,
  statementRestrictions: CanonicalAuthorizationPolicyInput['statementRestrictions'],
): CanonicalAuthorizationPolicyInput {
  return {
    installationId,
    workspaceId: 'workspace-1',
    ownerPrincipalId: 'principal-1',
    visibility: scope,
    statementRestrictions,
    expectedAuthorizationRevision,
  };
}

function runOptions() {
  return {
    maxJobs: 10,
    maxRebuildRoots: 10,
    maxChunkBytes: 64,
    leaseMilliseconds: 30_000,
  };
}

async function count(db: D1DatabaseLike, table: string): Promise<number> {
  const result = await db
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .all<{ count: number }>();
  return Number(result.results[0]?.count ?? 0);
}

async function downgradeTo0005(db: D1DatabaseLike): Promise<void> {
  await dropSchemaObjects(db, taprootExternalSearchProducerSchemaStatements);
  await dropSchemaObjects(db, taprootSearchMaterializationSchemaStatements);
  await dropSchemaObjects(db, taprootSearchSourceEventSchemaStatements);
  await db.batch(
    taprootSearchSourceEventSchemaStatements.map((sql) => db.prepare(sql)),
  );
  await db.batch([
    db.prepare(`DELETE FROM taproot_migrations WHERE version >= 6`),
    db.prepare(
      `DELETE FROM _gnolith_migrations
       WHERE namespace = '@gnolith/taproot'
         AND migration_id IN (
           '0006-unified-search-materialization-lifecycle',
           '0007-external-search-producers'
         )`,
    ),
  ]);
}

async function dropSchemaObjects(
  db: D1DatabaseLike,
  statements: readonly string[],
): Promise<void> {
  const objects = statements
    .map((sql) =>
      /^CREATE (TABLE|INDEX|TRIGGER) (?:IF NOT EXISTS )?([a-z0-9_]+)/iu.exec(
        sql,
      ),
    )
    .filter((match): match is RegExpExecArray => match !== null)
    .reverse();
  await db.batch(
    objects.map((match) =>
      db.prepare(`DROP ${match[1]!.toUpperCase()} IF EXISTS ${match[2]}`),
    ),
  );
}

async function migrationCount(db: D1DatabaseLike, id: string): Promise<number> {
  const result = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM _gnolith_migrations
       WHERE namespace = '@gnolith/taproot' AND migration_id = ?`,
    )
    .bind(id)
    .all<{ count: number }>();
  return Number(result.results[0]?.count ?? 0);
}

async function activeEligibility(db: D1DatabaseLike): Promise<number> {
  const result = await db
    .prepare(
      `SELECT h.eligible FROM taproot_search_materialization_heads h
       JOIN taproot_search_installation_state s
         ON s.active_corpus_id = h.corpus_id
       WHERE h.root_kind = 'item' AND h.root_id = 'Q1'`,
    )
    .all<{ eligible: number }>();
  return Number(result.results[0]?.eligible);
}

async function visibleDocuments(db: D1DatabaseLike) {
  const result = await db
    .prepare(
      `SELECT d.document_slot, d.document_id, d.document_text
       FROM taproot_search_installation_state s
       JOIN taproot_search_materialization_heads h
         ON h.corpus_id = s.active_corpus_id AND h.eligible = 1
       JOIN taproot_search_staged_documents d
         ON d.stage_id = h.current_stage_id
       WHERE s.installation_id = ?
       ORDER BY d.document_slot`,
    )
    .bind(installationId)
    .all<{
      document_slot: string;
      document_id: string;
      document_text: string;
    }>();
  return result.results;
}
