import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { D1DatabaseLike } from '@gnolith/diamond';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InvalidAuthorizationError,
  InvalidSearchSourceEventError,
  KNOWLEDGE_POLICY_CAPABILITY,
  KNOWLEDGE_WRITE_CAPABILITY,
  SearchSourceReplayConflictError,
  TaprootMigrationStateError,
  UNIFIED_SEARCH_SOURCE_KINDS_V1,
  addStatement,
  applyTaprootMigrations,
  bootstrapTaprootAuthorization,
  createInstallationAuthorizationGuard,
  createInstallationSearchSourceGuardV1,
  createItem,
  createProperty,
  createStatement,
  createTaprootHostWriteCapability,
  initializeTaproot,
  inspectTaprootSchema,
  normalizeInstallationSearchSourceBindingV1,
  normalizeUnifiedSearchSourceEventInputV1,
  planTaprootMigrations,
  redirectEntity,
  restoreEntity,
  setLabel,
  softDeleteEntity,
  type AuthorizationContext,
  type CanonicalAuthorizationPolicyInput,
  type TaprootHostWriteCapability,
  type UnifiedSearchSourceEventInputV1,
  type VisibilityScopeV1,
} from '../src/index.js';
import { TaprootRepository } from '../src/repository.js';

const options = { baseIri: 'https://source-events.example' };
const installationId = 'installation-source-events-1';
const publicScope: VisibilityScopeV1 = { version: 1, clauses: [] };
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('unified-search source-event migration 0005', () => {
  it('pins the reproducible 100k artifact cardinality and indexed lookup without an SLA', () => {
    const artifact = JSON.parse(
      readFileSync('benchmarks/search-source-events-100k.json', 'utf8'),
    ) as {
      workload: { sourceEvents: number; statementsPerSource: number };
      result: { events: number; registry: number; replayLookupPlan: string };
      sla: unknown;
    };
    expect(artifact.workload).toMatchObject({
      sourceEvents: 100_000,
      statementsPerSource: 2,
    });
    expect(artifact.result).toMatchObject({
      events: 100_000,
      registry: 100_000,
    });
    expect(artifact.result.replayLookupPlan).toContain('INDEX');
    expect(artifact.sla).toBeNull();
  });

  it('upgrades the exact 0004 persisted catalog without backfill and survives restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'taproot-source-migration-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'taproot.sqlite');
    let db = new NodeSqliteDatabase(path);
    await initializeTaproot(db, options);
    await new TaprootRepository(db, options).createItem({
      id: 'Q1',
      labels: { en: { language: 'en', value: 'legacy canonical row' } },
    });
    await downgradeTo0004(db);
    expect(await planTaprootMigrations(db)).toMatchObject([
      { id: '0001-v0.1-schema', status: 'applied' },
      { id: '0002-durable-database-identity', status: 'applied' },
      { id: '0003-canonical-statement-text', status: 'applied' },
      { id: '0004-canonical-authorization-policy', status: 'applied' },
      { id: '0005-unified-search-source-events', status: 'pending' },
    ]);
    await applyTaprootMigrations(db, options);
    expect((await inspectTaprootSchema(db)).valid).toBe(true);
    expect(await count(db, 'taproot_unified_search_source_events')).toBe(0);
    expect(await count(db, 'taproot_unified_search_source_registry')).toBe(0);
    await db.close();
    db = new NodeSqliteDatabase(path);
    try {
      expect((await inspectTaprootSchema(db)).valid).toBe(true);
      expect(
        (await planTaprootMigrations(db)).every(
          ({ status }) => status === 'applied',
        ),
      ).toBe(true);
    } finally {
      await db.close();
    }
  });

  it('rejects a drifted 0004 predecessor without stamping migration 0005', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    try {
      await initializeTaproot(db, options);
      await downgradeTo0004(db);
      await db.batch([
        db.prepare(`DROP INDEX taproot_authorization_outbox_state_idx`),
        db.prepare(
          `CREATE INDEX taproot_authorization_outbox_state_idx
           ON taproot_authorization_projection_outbox(event_id)`,
        ),
      ]);
      await expect(applyTaprootMigrations(db, options)).rejects.toBeInstanceOf(
        TaprootMigrationStateError,
      );
      expect(
        await migrationCount(db, '0005-unified-search-source-events'),
      ).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('creates the same strict empty catalog on real Workerd D1', async () => {
    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-07-19',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: crypto.randomUUID() },
    });
    try {
      const db = (await miniflare.getD1Database(
        'DB',
      )) as unknown as D1DatabaseLike;
      await initializeTaproot(db, options);
      expect((await inspectTaprootSchema(db)).valid).toBe(true);
      expect(await count(db, 'taproot_unified_search_source_events')).toBe(0);
    } finally {
      await miniflare.dispose();
    }
  }, 30_000);

  it('upgrades the exact 0004 catalog without backfill on real Workerd D1', async () => {
    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-07-19',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: crypto.randomUUID() },
    });
    try {
      const db = (await miniflare.getD1Database(
        'DB',
      )) as unknown as D1DatabaseLike;
      await initializeTaproot(db, options);
      await new TaprootRepository(db, options).createItem({ id: 'Q1' });
      await downgradeTo0004(db);
      await applyTaprootMigrations(db, options);
      expect((await inspectTaprootSchema(db)).valid).toBe(true);
      expect(await count(db, 'taproot_unified_search_source_events')).toBe(0);
      expect(await count(db, 'taproot_unified_search_source_registry')).toBe(0);
    } finally {
      await miniflare.dispose();
    }
  }, 30_000);
});

describe('opaque InstallationSearchSourceGuardV1', () => {
  it('validates every source kind and rejects caller-shaped authority fields', () => {
    for (const sourceKind of UNIFIED_SEARCH_SOURCE_KINDS_V1) {
      expect(
        normalizeInstallationSearchSourceBindingV1({
          domain: `domain-${sourceKind}`,
          sourceKind,
          capability: `${sourceKind}:write`,
          changeClasses: ['canonical'],
        }),
      ).toMatchObject({ sourceKind });
    }
    expect(() =>
      normalizeInstallationSearchSourceBindingV1({
        domain: 'tasks',
        sourceKind: 'unknown' as never,
        capability: 'task:write',
        changeClasses: ['canonical'],
      }),
    ).toThrow(InvalidSearchSourceEventError);
    expect(() =>
      normalizeUnifiedSearchSourceEventInputV1(
        {
          ...sourceEvent('event-extra', 'task-1', 'r1', null),
          installationId,
        } as never,
        { changeClasses: ['canonical'] },
      ),
    ).toThrow(InvalidSearchSourceEventError);
    const sparseChangeClasses = new Array<string>(2);
    sparseChangeClasses[1] = 'canonical';
    expect(() =>
      normalizeInstallationSearchSourceBindingV1({
        domain: 'tasks',
        sourceKind: 'task',
        capability: 'task:write',
        changeClasses: sparseChangeClasses,
      }),
    ).toThrow(InvalidSearchSourceEventError);
  });

  it('commits sibling SQL, one generation, event and registry atomically; exact replay is a no-op', async () => {
    const env = await nodeEnvironment();
    try {
      await bootstrapTaprootAuthorization(
        env.db,
        options,
        env.capability,
        installationId,
      );
      await env.db
        .prepare(`CREATE TABLE test_domain_values(value TEXT UNIQUE) STRICT`)
        .run();
      const guard = await createInstallationSearchSourceGuardV1(
        env.db,
        options,
        env.capability,
        taskBinding(),
      );
      const first = sourceEvent('task-event-1', 'task-1', 'opaque-r1', null);
      const receipt = await guard.batchWithSourceEvent(taskContext(), first, [
        env.db.prepare(
          `INSERT INTO test_domain_values(value) VALUES ('first')`,
        ),
      ]);
      expect(receipt).toMatchObject({
        authorizationRevision: 1,
        searchGeneration: 2,
        replayed: false,
      });
      expect(receipt.results).toHaveLength(6);
      const replay = await guard.batchWithSourceEvent(taskContext(), first, [
        env.db.prepare(
          `INSERT INTO test_domain_values(value) VALUES ('replay-must-not-run')`,
        ),
      ]);
      expect(replay).toMatchObject({ searchGeneration: 2, replayed: true });
      expect(await count(env.db, 'test_domain_values')).toBe(1);
      expect(await count(env.db, 'taproot_unified_search_source_events')).toBe(
        1,
      );
      expect(
        await count(env.db, 'taproot_unified_search_source_registry'),
      ).toBe(1);
      expect(await installationGeneration(env.db)).toBe(2);
      await expect(
        env.db
          .prepare(
            `UPDATE taproot_unified_search_source_events
             SET source_revision = 'rewritten' WHERE event_id = 'task-event-1'`,
          )
          .run(),
      ).rejects.toBeDefined();
      await expect(
        env.db
          .prepare(
            `DELETE FROM taproot_unified_search_source_events
             WHERE event_id = 'task-event-1'`,
          )
          .run(),
      ).rejects.toBeDefined();
      await expect(
        env.db
          .prepare(
            `UPDATE taproot_unified_search_source_registry
             SET domain = 'other' WHERE source_id = 'task-1'`,
          )
          .run(),
      ).rejects.toBeDefined();
      const queryPlan = await env.db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT event_id, payload_hash FROM taproot_unified_search_source_events
           WHERE installation_id = ? AND source_kind = ? AND source_id = ?
             AND source_revision = ?`,
        )
        .bind(installationId, 'task', 'task-1', 'opaque-r1')
        .all<{ detail: string }>();
      expect(queryPlan.results.map(({ detail }) => detail).join(' ')).toMatch(
        /taproot_search_source_events_replay_idx|sqlite_autoindex_taproot_unified_search_source_events/u,
      );
      expect(() =>
        normalizeUnifiedSearchSourceEventInputV1(
          { ...first, sourceId: 'x'.repeat(257) },
          taskBinding(),
        ),
      ).toThrow(InvalidSearchSourceEventError);
      await expect(
        guard.batchWithSourceEvent(
          taskContext(),
          { ...first, sourceHash: 'b'.repeat(64) },
          [
            env.db.prepare(
              `INSERT INTO test_domain_values(value) VALUES ('bad')`,
            ),
          ],
        ),
      ).rejects.toBeInstanceOf(SearchSourceReplayConflictError);
      expect(await count(env.db, 'test_domain_values')).toBe(1);
      expect(await installationGeneration(env.db)).toBe(2);
    } finally {
      await env.close();
    }
  });

  it('fences predecessor races, domain capabilities, installations, and rollback boundaries', async () => {
    const env = await nodeEnvironment();
    try {
      await bootstrapTaprootAuthorization(
        env.db,
        options,
        env.capability,
        installationId,
      );
      await env.db
        .prepare(`CREATE TABLE test_domain_values(value TEXT UNIQUE) STRICT`)
        .run();
      const guard = await createInstallationSearchSourceGuardV1(
        env.db,
        options,
        env.capability,
        taskBinding(),
      );
      const first = sourceEvent('task-event-1', 'task-1', 'r1', null);
      await guard.batchWithSourceEvent(taskContext(), first, [
        env.db.prepare(
          `INSERT INTO test_domain_values(value) VALUES ('first')`,
        ),
      ]);
      const predecessor = await currentPredecessor(env.db, 'task', 'task-1');
      const attempts = await Promise.allSettled([
        guard.batchWithSourceEvent(
          taskContext(),
          sourceEvent('task-event-2a', 'task-1', 'r2a', predecessor),
          [
            env.db.prepare(
              `INSERT INTO test_domain_values(value) VALUES ('winner-a')`,
            ),
          ],
        ),
        guard.batchWithSourceEvent(
          taskContext(),
          sourceEvent('task-event-2b', 'task-1', 'r2b', predecessor),
          [
            env.db.prepare(
              `INSERT INTO test_domain_values(value) VALUES ('winner-b')`,
            ),
          ],
        ),
      ]);
      expect(
        attempts.filter(({ status }) => status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        attempts.filter(({ status }) => status === 'rejected'),
      ).toHaveLength(1);
      expect(await installationGeneration(env.db)).toBe(3);
      expect(await count(env.db, 'taproot_unified_search_source_events')).toBe(
        2,
      );

      const next = await currentPredecessor(env.db, 'task', 'task-1');
      await expect(
        guard.batchWithSourceEvent(
          taskContext(),
          sourceEvent('task-event-rollback', 'task-1', 'r3', next),
          [
            env.db.prepare(
              `INSERT INTO test_domain_values(value) VALUES ('first')`,
            ),
          ],
        ),
      ).rejects.toBeDefined();
      expect(await installationGeneration(env.db)).toBe(3);
      expect(await count(env.db, 'taproot_unified_search_source_events')).toBe(
        2,
      );

      await expect(
        guard.batchWithSourceEvent(
          { ...taskContext(), installationId: 'other-installation' },
          sourceEvent('cross-install', 'task-2', 'r1', null),
          [
            env.db.prepare(
              `INSERT INTO test_domain_values(value) VALUES ('cross')`,
            ),
          ],
        ),
      ).rejects.toBeInstanceOf(InvalidAuthorizationError);
      await expect(
        guard.batchWithSourceEvent(
          { ...taskContext(), capabilities: ['memory:write'] },
          sourceEvent('cross-capability', 'task-2', 'r1', null),
          [
            env.db.prepare(
              `INSERT INTO test_domain_values(value) VALUES ('cap')`,
            ),
          ],
        ),
      ).rejects.toBeInstanceOf(InvalidAuthorizationError);
    } finally {
      await env.close();
    }
  });

  it('commits, replays, rolls back, and fences predecessor races on real Workerd D1', async () => {
    const env = await workerdEnvironment();
    try {
      await bootstrapTaprootAuthorization(
        env.db,
        options,
        env.capability,
        installationId,
      );
      await env.db
        .prepare(`CREATE TABLE test_domain_values(value TEXT UNIQUE) STRICT`)
        .run();
      const guard = await createInstallationSearchSourceGuardV1(
        env.db,
        options,
        env.capability,
        taskBinding(),
      );
      const first = sourceEvent('workerd-task-event-1', 'task-1', 'r1', null);
      expect(
        await guard.batchWithSourceEvent(taskContext(), first, [
          env.db.prepare(
            `INSERT INTO test_domain_values(value) VALUES ('first')`,
          ),
        ]),
      ).toMatchObject({ searchGeneration: 2, replayed: false });
      expect(
        await guard.batchWithSourceEvent(taskContext(), first, [
          env.db.prepare(
            `INSERT INTO test_domain_values(value) VALUES ('replay-must-not-run')`,
          ),
        ]),
      ).toMatchObject({ searchGeneration: 2, replayed: true });

      const predecessor = await currentPredecessor(env.db, 'task', 'task-1');
      const attempts = await Promise.allSettled([
        guard.batchWithSourceEvent(
          taskContext(),
          sourceEvent('workerd-task-event-2a', 'task-1', 'r2a', predecessor),
          [
            env.db.prepare(
              `INSERT INTO test_domain_values(value) VALUES ('winner-a')`,
            ),
          ],
        ),
        guard.batchWithSourceEvent(
          taskContext(),
          sourceEvent('workerd-task-event-2b', 'task-1', 'r2b', predecessor),
          [
            env.db.prepare(
              `INSERT INTO test_domain_values(value) VALUES ('winner-b')`,
            ),
          ],
        ),
      ]);
      expect(
        attempts.filter(({ status }) => status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        attempts.filter(({ status }) => status === 'rejected'),
      ).toHaveLength(1);
      expect(await installationGeneration(env.db)).toBe(3);
      expect(await count(env.db, 'taproot_unified_search_source_events')).toBe(
        2,
      );
      expect(await count(env.db, 'test_domain_values')).toBe(2);

      const next = await currentPredecessor(env.db, 'task', 'task-1');
      await expect(
        guard.batchWithSourceEvent(
          taskContext(),
          sourceEvent('workerd-task-rollback', 'task-1', 'r3', next),
          [
            env.db.prepare(
              `INSERT INTO test_domain_values(value) VALUES ('first')`,
            ),
          ],
        ),
      ).rejects.toBeDefined();
      expect(await installationGeneration(env.db)).toBe(3);
      expect(await count(env.db, 'taproot_unified_search_source_events')).toBe(
        2,
      );

      await expectMalformedSourcePointersRejected(env.db, guard);
    } finally {
      await env.close();
    }
  }, 30_000);

  it('rejects malformed predecessor and registry pointers on Node SQLite', async () => {
    const env = await nodeEnvironment();
    try {
      await bootstrapTaprootAuthorization(
        env.db,
        options,
        env.capability,
        installationId,
      );
      const guard = await createInstallationSearchSourceGuardV1(
        env.db,
        options,
        env.capability,
        taskBinding(),
      );
      await expectMalformedSourcePointersRejected(env.db, guard);
    } finally {
      await env.close();
    }
  });
});

describe('Taproot Item root source events', () => {
  it('emits one Item root event per canonical, authorization, statement, delete, and restore mutation without disclosure fields', async () => {
    const env = await nodeEnvironment();
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
      await createProperty(env.db, options, guard, knowledgeContext(1), {
        id: 'P1',
        datatype: 'string',
        authorization: policy(1),
      });
      await createItem(env.db, options, guard, knowledgeContext(2), {
        id: 'Q1',
        labels: { en: { language: 'en', value: 'SECRET-LABEL-CANARY' } },
        authorization: policy(2),
      });
      const workspaceScope: VisibilityScopeV1 = {
        version: 1,
        clauses: [[{ kind: 'workspace', workspaceId: 'workspace-1' }]],
      };
      await setLabel(
        env.db,
        options,
        guard,
        knowledgeContext(3, true),
        'Q1',
        'en',
        'SECRET-LABEL-CANARY-CHANGED',
        {
          expectedRevision: 1,
          authorization: policy(3, {}, workspaceScope),
        },
      );
      const statement = createStatement(
        'Q1',
        {
          snaktype: 'value',
          property: 'P1',
          datatype: 'string',
          datavalue: { type: 'string', value: 'SECRET-VALUE-CANARY' },
        },
        'SECRET-TEXT-CANARY',
        { id: 'Q1$SECRET-STATEMENT-CANARY' },
      );
      await addStatement(
        env.db,
        options,
        guard,
        knowledgeContext(4, true),
        'Q1',
        statement,
        {
          expectedRevision: 2,
          authorization: policy(4, { [statement.id]: [] }, workspaceScope),
        },
      );
      await softDeleteEntity(
        env.db,
        options,
        guard,
        knowledgeContext(5),
        'Q1',
        {
          expectedRevision: 3,
          authorization: policy(5, { [statement.id]: [] }, workspaceScope),
        },
      );
      await restoreEntity(env.db, options, guard, knowledgeContext(6), 'Q1', {
        expectedRevision: 4,
        authorization: policy(6, { [statement.id]: [] }, workspaceScope),
      });
      await createItem(env.db, options, guard, knowledgeContext(7), {
        id: 'Q2',
        authorization: policy(7),
      });
      await redirectEntity(
        env.db,
        options,
        guard,
        knowledgeContext(8),
        'Q1',
        'Q2',
        {
          expectedRevision: 5,
          authorization: policy(8, { [statement.id]: [] }, workspaceScope),
        },
      );
      const rows = await env.db
        .prepare(
          `SELECT * FROM taproot_unified_search_source_events
           WHERE source_id = 'Q1' ORDER BY sequence`,
        )
        .all<Record<string, unknown>>();
      expect(rows.results).toHaveLength(6);
      expect(rows.results.map(({ source_kind }) => source_kind)).toEqual(
        Array(6).fill('item'),
      );
      expect(rows.results.map(({ source_id }) => source_id)).toEqual(
        Array(6).fill('Q1'),
      );
      expect(
        rows.results.map(({ source_revision }) => source_revision),
      ).toEqual(['1', '2', '3', '4', '5', '6']);
      expect(rows.results[1]?.predecessor_event_id).toBe(
        rows.results[0]?.event_id,
      );
      expect(rows.results[1]?.search_generation).toBe(4);
      expect(rows.results.map(({ change_class }) => change_class)).toEqual([
        'canonical',
        'authorization',
        'authorization',
        'eligibility',
        'eligibility',
        'eligibility',
      ]);
      expect(rows.results.map(({ operation }) => operation)).toEqual([
        'upsert',
        'upsert',
        'upsert',
        'delete',
        'upsert',
        'delete',
      ]);
      expect(JSON.stringify(rows.results)).not.toMatch(
        /SECRET-(?:LABEL|VALUE|TEXT|STATEMENT)-CANARY/u,
      );
      expect(
        await count(env.db, 'taproot_authorization_projection_outbox'),
      ).toBe(8);
      expect(await count(env.db, 'taproot_unified_search_source_events')).toBe(
        7,
      );
    } finally {
      await env.close();
    }
  });
});

async function nodeEnvironment(): Promise<{
  db: NodeSqliteDatabase;
  capability: TaprootHostWriteCapability;
  close(): Promise<void>;
}> {
  const directory = mkdtempSync(join(tmpdir(), 'taproot-source-events-'));
  temporaryDirectories.push(directory);
  const db = new NodeSqliteDatabase(join(directory, 'taproot.sqlite'));
  await initializeTaproot(db, options);
  return { db, capability: await writeCapability(db), close: () => db.close() };
}

async function workerdEnvironment(): Promise<{
  db: D1DatabaseLike;
  capability: TaprootHostWriteCapability;
  close(): Promise<void>;
}> {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-19',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: crypto.randomUUID() },
  });
  const db = (await miniflare.getD1Database('DB')) as unknown as D1DatabaseLike;
  await initializeTaproot(db, options);
  return {
    db,
    capability: await writeCapability(db),
    close: () => miniflare.dispose(),
  };
}

async function expectMalformedSourcePointersRejected(
  db: D1DatabaseLike,
  guard: Awaited<ReturnType<typeof createInstallationSearchSourceGuardV1>>,
): Promise<void> {
  const first = sourceEvent('integrity-event-1', 'integrity-task', 'r1', null);
  await guard.batchWithSourceEvent(taskContext(), first, [domainNoop(db)]);
  const firstPredecessor = await currentPredecessor(
    db,
    'task',
    'integrity-task',
  );
  await guard.batchWithSourceEvent(
    taskContext(),
    sourceEvent('integrity-event-2', 'integrity-task', 'r2', firstPredecessor),
    [domainNoop(db)],
  );
  const secondPredecessor = await currentPredecessor(
    db,
    'task',
    'integrity-task',
  );
  const generation = await installationGeneration(db);
  await expect(
    db
      .prepare(
        `INSERT INTO taproot_unified_search_source_events(
           event_id, installation_id, domain, source_kind, source_id,
           operation, change_class, source_revision, source_hash,
           authorization_revision, search_generation, predecessor_event_id,
           predecessor_sequence, payload_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        'integrity-bad-pair',
        installationId,
        'tasks',
        'task',
        'integrity-task',
        'upsert',
        'canonical',
        'r3-bad',
        'a'.repeat(64),
        1,
        generation + 1,
        firstPredecessor.eventId,
        secondPredecessor.sequence,
        'b'.repeat(64),
        '2026-07-22T00:00:00.000Z',
      )
      .run(),
  ).rejects.toBeDefined();

  const stagedCreatedAt = '2026-07-22T00:00:01.000Z';
  await db
    .prepare(
      `INSERT INTO taproot_unified_search_source_events(
         event_id, installation_id, domain, source_kind, source_id,
         operation, change_class, source_revision, source_hash,
         authorization_revision, search_generation, predecessor_event_id,
         predecessor_sequence, payload_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      'integrity-staged-event-3',
      installationId,
      'tasks',
      'task',
      'integrity-task',
      'upsert',
      'canonical',
      'r3-staged',
      'c'.repeat(64),
      1,
      generation + 1,
      secondPredecessor.eventId,
      secondPredecessor.sequence,
      'd'.repeat(64),
      stagedCreatedAt,
    )
    .run();
  const staged = await db
    .prepare(
      `SELECT sequence FROM taproot_unified_search_source_events
       WHERE event_id = 'integrity-staged-event-3'`,
    )
    .all<{ sequence: number }>();
  await expect(
    db
      .prepare(
        `UPDATE taproot_unified_search_source_registry SET
           current_event_id = 'integrity-staged-event-3',
           current_event_sequence = ?, operation = 'upsert',
           change_class = 'canonical', source_revision = 'r3-staged',
           source_hash = ?, authorization_revision = 1,
           search_generation = ?, payload_hash = ?, updated_at = ?
         WHERE installation_id = ? AND source_kind = 'task'
           AND source_id = 'integrity-task'`,
      )
      .bind(
        Number(staged.results[0]?.sequence),
        'c'.repeat(64),
        generation + 1,
        'e'.repeat(64),
        stagedCreatedAt,
        installationId,
      )
      .run(),
  ).rejects.toBeDefined();
  expect(await currentPredecessor(db, 'task', 'integrity-task')).toEqual(
    secondPredecessor,
  );
}

function domainNoop(db: D1DatabaseLike) {
  return db.prepare(
    `UPDATE taproot_metadata SET metadata_value = metadata_value
     WHERE metadata_key = 'schema_version'`,
  );
}

async function writeCapability(db: D1DatabaseLike) {
  const key = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return createTaprootHostWriteCapability(db, options, key);
}

function taskBinding() {
  return {
    domain: 'tasks',
    sourceKind: 'task' as const,
    capability: 'task:write',
    changeClasses: ['canonical'] as const,
  };
}

function taskContext(): AuthorizationContext {
  return {
    installationId,
    principalId: 'principal-1',
    activeWorkspaceId: null,
    workspaceIds: [],
    capabilities: ['task:write'],
    authorizationRevision: 1,
  };
}

function knowledgeContext(
  authorizationRevision: number,
  policyAuthority = false,
): AuthorizationContext {
  return {
    ...taskContext(),
    activeWorkspaceId: 'workspace-1',
    workspaceIds: ['workspace-1'],
    capabilities: [
      KNOWLEDGE_WRITE_CAPABILITY,
      ...(policyAuthority ? [KNOWLEDGE_POLICY_CAPABILITY] : []),
    ],
    authorizationRevision,
  };
}

function policy(
  expectedAuthorizationRevision: number,
  statementRestrictions: CanonicalAuthorizationPolicyInput['statementRestrictions'] = {},
  visibility: VisibilityScopeV1 = publicScope,
): CanonicalAuthorizationPolicyInput {
  return {
    installationId,
    workspaceId: null,
    ownerPrincipalId: 'principal-1',
    visibility,
    statementRestrictions,
    expectedAuthorizationRevision,
  };
}

function sourceEvent(
  eventId: string,
  sourceId: string,
  sourceRevision: string,
  predecessor: UnifiedSearchSourceEventInputV1['predecessor'],
): UnifiedSearchSourceEventInputV1 {
  return {
    eventId,
    sourceId,
    operation: 'upsert',
    changeClass: 'canonical',
    sourceRevision,
    sourceHash: 'a'.repeat(64),
    predecessor,
  };
}

async function currentPredecessor(
  db: D1DatabaseLike,
  sourceKind: string,
  sourceId: string,
) {
  const result = await db
    .prepare(
      `SELECT current_event_id, current_event_sequence
       FROM taproot_unified_search_source_registry
       WHERE installation_id = ? AND source_kind = ? AND source_id = ?`,
    )
    .bind(installationId, sourceKind, sourceId)
    .all<{ current_event_id: string; current_event_sequence: number }>();
  const row = result.results[0]!;
  return {
    eventId: row.current_event_id,
    sequence: Number(row.current_event_sequence),
  };
}

async function installationGeneration(db: D1DatabaseLike): Promise<number> {
  const result = await db
    .prepare(
      `SELECT search_generation FROM taproot_installation_authorization WHERE singleton = 1`,
    )
    .all<{ search_generation: number }>();
  return Number(result.results[0]?.search_generation);
}

async function count(db: D1DatabaseLike, table: string): Promise<number> {
  const result = await db
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .all<{ count: number }>();
  return Number(result.results[0]?.count ?? 0);
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

async function downgradeTo0004(db: D1DatabaseLike): Promise<void> {
  await db.batch([
    db.prepare(`DROP TABLE taproot_unified_search_source_registry`),
    db.prepare(`DROP TABLE taproot_unified_search_source_events`),
    db.prepare(`DELETE FROM taproot_migrations WHERE version = 5`),
    db.prepare(
      `DELETE FROM _gnolith_migrations
       WHERE namespace = '@gnolith/taproot'
         AND migration_id = '0005-unified-search-source-events'`,
    ),
    db.prepare(
      `UPDATE taproot_metadata SET metadata_value = '3'
       WHERE metadata_key = 'schema_version'`,
    ),
  ]);
}
