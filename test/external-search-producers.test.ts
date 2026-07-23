import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { D1DatabaseLike } from '@gnolith/diamond';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootstrapTaprootAuthorization,
  createTaprootHostWriteCapability,
  initializeTaproot,
  type AuthorizationContext,
} from '../src/index.js';
import {
  registerExternalProducerKindV1,
  registerExternalProducerV1,
  createSearchMaterializationAdminGuardV1,
  type ExternalProducer,
} from '../src/search.js';

const options = { baseIri: 'https://generic-producer.example' };
const installationId = 'generic-producer-installation';
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('generic external producer boundary', () => {
  it('brands namespace handles and atomically consumes an owner participant once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'taproot-generic-producer-'));
    directories.push(directory);
    const db = new NodeSqliteDatabase(join(directory, 'taproot.sqlite'));
    try {
      await initializeTaproot(db, options);
      const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const authority = createTaprootHostWriteCapability(db, options, key);
      await bootstrapTaprootAuthorization(
        db,
        options,
        authority,
        installationId,
      );
      await db
        .prepare(
          `CREATE TABLE fixture_owner_records(
             source_id TEXT PRIMARY KEY, revision TEXT NOT NULL
           ) STRICT`,
        )
        .run();
      const registeredKind = await registerExternalProducerKindV1(
        db,
        options,
        authority,
        {
          installationId,
          namespace: 'fixture.example',
          localName: 'note',
          ownerDomain: 'fixture-owner',
          adapter: {
            kind: 'taproot-external-owner-transaction-adapter-v1',
            prepare(token) {
              const input = token as { sourceId: string; revision: string };
              return Promise.resolve([
                db
                  .prepare(
                    `INSERT INTO fixture_owner_records(source_id, revision)
                     VALUES (?, ?)`,
                  )
                  .bind(input.sourceId, input.revision),
              ]);
            },
          },
        },
      );
      expect(Object.isFrozen(registeredKind.kind)).toBe(true);
      expect(Object.isFrozen(registeredKind.registration)).toBe(true);
      const source = {
        sourceId: 'fixture-1',
        sourceRevision: '1',
        sourcePolicyRevision: 1,
        canonical: { title: 'A generic fixture' },
      };
      const legacyIds = Array.from(
        { length: 1001 },
        (_, index) => `fixture-${index + 1}`,
      );
      const producer: ExternalProducer = {
        descriptor: {
          registration: registeredKind.registration,
          implementationVersion: '1.0.0',
          fingerprint: 'f'.repeat(64),
          projectionVersion: 'fixture-projection-v1',
          changeClasses: ['canonical'],
        },
        enumerate: (cursor, limit) => {
          const start = cursor === null ? 0 : Number(cursor);
          const ids = legacyIds.slice(start, start + limit);
          const next = start + ids.length;
          return Promise.resolve({
            ids,
            cursor: next < legacyIds.length ? String(next) : null,
          });
        },
        loadExact: (sourceId) =>
          Promise.resolve(
            sourceId === source.sourceId
              ? source
              : {
                  sourceId,
                  sourceRevision: '1',
                  sourcePolicyRevision: 1,
                  canonical: { title: sourceId },
                },
          ),
        project: () => Promise.resolve({ text: 'A generic fixture document' }),
        authorize: (_reference, context) =>
          Promise.resolve(context.installationId === installationId),
        hydrate: () => Promise.resolve(source.canonical),
      };
      const registered = await registerExternalProducerV1(
        db,
        options,
        authority,
        producer,
      );
      const materialization = await createSearchMaterializationAdminGuardV1(
        db,
        options,
        authority,
      );
      await materialization.initialize(adminContext());
      await expect(
        registered.adopt(adminContext(), { limit: 1000 }),
      ).resolves.toEqual({
        enumerated: 1000,
        adopted: 1000,
        cursor: '1000',
      });
      await expect(
        registered.adopt(adminContext(), { cursor: '1000', limit: 1000 }),
      ).resolves.toEqual({
        enumerated: 1,
        adopted: 1,
        cursor: null,
      });
      const adoptedPredecessor = await registered.currentPredecessor(
        source.sourceId,
      );
      expect(adoptedPredecessor).not.toBeNull();
      await expect(
        materialization.run(adminContext(), {
          maxJobs: 10,
          maxRebuildRoots: 10,
        }),
      ).resolves.toMatchObject({ completed: 10, deferred: 0 });
      await expect(
        registered.currentPredecessor('fixture-1001'),
      ).resolves.not.toBeNull();
      source.sourceRevision = '2';
      const participant = await registered.issuer.seal({
        sourceId: source.sourceId,
        sourceRevision: source.sourceRevision,
        predecessor: adoptedPredecessor,
        ownerMutationToken: {
          sourceId: source.sourceId,
          revision: source.sourceRevision,
        },
      });
      expect(Object.isFrozen(participant)).toBe(true);
      const receipt = await registered.commit(participant);
      expect(receipt.generation).toBe(2);
      await expect(registered.commit(participant)).rejects.toThrow(
        /invalid|consumed/u,
      );
      const rows = await db
        .prepare(`SELECT source_id, revision FROM fixture_owner_records`)
        .all<{ source_id: string; revision: string }>();
      expect(rows.results).toEqual([
        { source_id: source.sourceId, revision: source.sourceRevision },
      ]);
    } finally {
      await db.close();
    }
  });

  it('rejects forged, duplicate, reserved, and cross-connection handles', async () => {
    const firstDirectory = mkdtempSync(join(tmpdir(), 'taproot-kind-first-'));
    const secondDirectory = mkdtempSync(join(tmpdir(), 'taproot-kind-second-'));
    directories.push(firstDirectory, secondDirectory);
    const first = new NodeSqliteDatabase(join(firstDirectory, 'db.sqlite'));
    const second = new NodeSqliteDatabase(join(secondDirectory, 'db.sqlite'));
    try {
      await initializeTaproot(first, options);
      await initializeTaproot(second, options);
      const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const firstAuthority = createTaprootHostWriteCapability(
        first,
        options,
        key,
      );
      await bootstrapTaprootAuthorization(
        first,
        options,
        firstAuthority,
        installationId,
      );
      const input = {
        installationId,
        namespace: 'fixture.example',
        localName: 'record',
        ownerDomain: 'fixture-owner',
        adapter: {
          kind: 'taproot-external-owner-transaction-adapter-v1' as const,
          prepare: () => Promise.resolve([]),
        },
      };
      await registerExternalProducerKindV1(
        first,
        options,
        firstAuthority,
        input,
      );
      await expect(
        registerExternalProducerKindV1(first, options, firstAuthority, input),
      ).rejects.toThrow(/already registered/u);
      await expect(
        registerExternalProducerKindV1(first, options, firstAuthority, {
          ...input,
          namespace: 'taproot',
        }),
      ).rejects.toThrow(/reserved/u);
      const context: AuthorizationContext = {
        installationId,
        principalId: 'principal',
        activeWorkspaceId: null,
        workspaceIds: [],
        capabilities: [],
        authorizationRevision: 1,
      };
      expect(context.installationId).toBe(installationId);
    } finally {
      await first.close();
      await second.close();
    }
  });

  for (const runtime of [nativeRestartRuntime(), workerdRestartRuntime()]) {
    it(`continues first/second mutations across ${runtime.name} restart and rejects stale or forged predecessors`, async () => {
      const source = {
        sourceId: 'restart-source-1',
        sourceRevision: '1',
        sourcePolicyRevision: 1,
        canonical: { title: 'Restart-safe source' },
      };
      let env = await runtime.open();
      try {
        await initializeTaproot(env.db, options);
        await bootstrapFor(env.db);
        await env.db
          .prepare(
            `CREATE TABLE fixture_restart_owner_records(
               source_id TEXT PRIMARY KEY, revision TEXT NOT NULL
             ) STRICT`,
          )
          .run();
        let registered = await registerRestartProducer(env.db, source);
        const materializationKey = await crypto.subtle.generateKey(
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        );
        const materialization = await createSearchMaterializationAdminGuardV1(
          env.db,
          options,
          createTaprootHostWriteCapability(env.db, options, materializationKey),
        );
        await materialization.initialize(adminContext());
        expect(await registered.currentPredecessor(source.sourceId)).toBeNull();
        const first = await commitRestartMutation(registered, source, null);
        const firstPredecessor = await registered.currentPredecessor(
          source.sourceId,
        );
        expect(firstPredecessor?.eventId).toBe(first.eventId);
        expect(Number.isSafeInteger(firstPredecessor?.sequence)).toBe(true);
        expect(Object.isFrozen(firstPredecessor)).toBe(true);

        source.sourceRevision = '2';
        const second = await commitRestartMutation(
          registered,
          source,
          firstPredecessor,
        );
        expect(second.generation).toBe(first.generation + 1);
        const materializationReceipt = await materialization.run(
          adminContext(),
          {
            maxJobs: 10,
            maxRebuildRoots: 10,
            maxChunkBytes: 64,
            leaseMilliseconds: 30_000,
          },
        );
        expect(materializationReceipt).toMatchObject({
          completed: 1,
          superseded: 1,
          deferred: 0,
        });
        const secondPredecessor = await registered.currentPredecessor(
          source.sourceId,
        );
        expect(secondPredecessor).toEqual({
          eventId: second.eventId,
          sequence: firstPredecessor!.sequence + 1,
        });

        source.sourceRevision = '3';
        await expect(
          commitRestartMutation(registered, source, firstPredecessor),
        ).rejects.toThrow(/predecessor is stale/u);
        await expect(
          commitRestartMutation(registered, source, {
            ...secondPredecessor!,
            sequence: secondPredecessor!.sequence + 1,
          }),
        ).rejects.toThrow(/predecessor is stale/u);

        await env.close();
        env = await runtime.open();
        const mismatchedKey = await crypto.subtle.generateKey(
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        );
        await expect(
          registerExternalProducerKindV1(
            env.db,
            options,
            createTaprootHostWriteCapability(env.db, options, mismatchedKey),
            {
              installationId,
              namespace: 'restart.example',
              localName: 'record',
              ownerDomain: 'different-owner',
              adapter: {
                kind: 'taproot-external-owner-transaction-adapter-v1',
                prepare: () => Promise.resolve([]),
              },
            },
          ),
        ).rejects.toThrow(/does not match the durable owner/u);
        registered = await registerRestartProducer(env.db, source);
        expect(await registered.currentPredecessor(source.sourceId)).toEqual(
          secondPredecessor,
        );
        const third = await commitRestartMutation(
          registered,
          source,
          secondPredecessor,
        );
        expect(third.generation).toBe(second.generation + 1);
        const reopenedMaterializationKey = await crypto.subtle.generateKey(
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        );
        const reopenedMaterialization =
          await createSearchMaterializationAdminGuardV1(
            env.db,
            options,
            createTaprootHostWriteCapability(
              env.db,
              options,
              reopenedMaterializationKey,
            ),
          );
        await expect(
          reopenedMaterialization.run(adminContext(), {
            maxJobs: 10,
            maxRebuildRoots: 10,
          }),
        ).resolves.toMatchObject({ completed: 1, deferred: 0 });
      } finally {
        await env.close();
      }
    });
  }
});

type RestartSource = {
  sourceId: string;
  sourceRevision: string;
  sourcePolicyRevision: number;
  canonical: unknown;
};

async function bootstrapFor(db: D1DatabaseLike): Promise<void> {
  const key = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  await bootstrapTaprootAuthorization(
    db,
    options,
    createTaprootHostWriteCapability(db, options, key),
    installationId,
  );
}

async function registerRestartProducer(
  db: D1DatabaseLike,
  source: RestartSource,
) {
  const key = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const authority = createTaprootHostWriteCapability(db, options, key);
  const kind = await registerExternalProducerKindV1(db, options, authority, {
    installationId,
    namespace: 'restart.example',
    localName: 'record',
    ownerDomain: 'restart-owner',
    adapter: {
      kind: 'taproot-external-owner-transaction-adapter-v1',
      prepare(token) {
        const input = token as { sourceId: string; revision: string };
        return Promise.resolve([
          db
            .prepare(
              `INSERT INTO fixture_restart_owner_records(source_id, revision)
               VALUES (?, ?)
               ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision`,
            )
            .bind(input.sourceId, input.revision),
        ]);
      },
    },
  });
  const producer: ExternalProducer = {
    descriptor: {
      registration: kind.registration,
      implementationVersion: '1.0.0',
      fingerprint: 'a'.repeat(64),
      projectionVersion: 'restart-projection-v1',
      changeClasses: ['canonical'],
    },
    enumerate: () => Promise.resolve({ ids: [source.sourceId], cursor: null }),
    loadExact: () => Promise.resolve(source),
    project: () =>
      Promise.resolve({ text: 'Restart-safe source\nwith canonical fields' }),
    authorize: () => Promise.resolve(true),
    hydrate: () => Promise.resolve(source.canonical),
  };
  return registerExternalProducerV1(db, options, authority, producer);
}

function commitRestartMutation(
  registered: Awaited<ReturnType<typeof registerRestartProducer>>,
  source: RestartSource,
  predecessor: Awaited<
    ReturnType<
      Awaited<ReturnType<typeof registerRestartProducer>>['currentPredecessor']
    >
  >,
) {
  return registered.issuer
    .seal({
      sourceId: source.sourceId,
      sourceRevision: source.sourceRevision,
      predecessor,
      ownerMutationToken: {
        sourceId: source.sourceId,
        revision: source.sourceRevision,
      },
    })
    .then((participant) => registered.commit(participant));
}

function nativeRestartRuntime() {
  let path: string | null = null;
  return {
    name: 'persisted native SQLite',
    open: () => {
      if (!path) {
        const directory = mkdtempSync(
          join(tmpdir(), 'taproot-producer-native-'),
        );
        directories.push(directory);
        path = join(directory, 'taproot.sqlite');
      }
      const db = new NodeSqliteDatabase(path);
      return Promise.resolve({
        db,
        close: () => db.close(),
      });
    },
  };
}

function adminContext(): AuthorizationContext {
  return {
    installationId,
    principalId: 'admin',
    activeWorkspaceId: null,
    workspaceIds: [],
    capabilities: ['search:admin'],
    authorizationRevision: 1,
  };
}

function workerdRestartRuntime() {
  let directory: string | null = null;
  const databaseId = crypto.randomUUID();
  return {
    name: 'real Workerd D1',
    async open() {
      if (!directory) {
        directory = mkdtempSync(join(tmpdir(), 'taproot-producer-d1-'));
        directories.push(directory);
      }
      const miniflare = new Miniflare({
        modules: true,
        script: 'export default { fetch() { return new Response("ok") } }',
        compatibilityDate: '2026-07-19',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: databaseId },
        d1Persist: directory,
      });
      return {
        db: (await miniflare.getD1Database('DB')) as unknown as D1DatabaseLike,
        close: () => miniflare.dispose(),
      };
    },
  };
}
