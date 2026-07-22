import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import type { D1DatabaseLike } from '@gnolith/diamond';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthorizationDeniedError,
  InvalidEntityError,
  PersistedEntityAuthorizationSource,
  SEARCH_ADMIN_CAPABILITY,
  KNOWLEDGE_WRITE_CAPABILITY,
  KNOWLEDGE_POLICY_CAPABILITY,
  addStatement,
  bootstrapTaprootAuthorization,
  bootstrapLegacyTaprootAuthorization,
  createAuthorizationCursorCodec,
  createAuthorizedTaproot,
  createItem,
  createProperty,
  createStatement,
  createTaprootHostWriteCapability,
  createInstallationAuthorizationGuard,
  initializeTaproot,
  inspectTaprootAuthorizationReadiness,
  planTaprootAuthorizationBackfill,
  applyTaprootAuthorizationBackfill,
  setLabel,
  type AuthorizationContext,
  type CanonicalAuthorizationPolicyInput,
  type TaprootHostWriteCapability,
  type VisibilityScopeV1,
} from '../src/index.js';
import { TaprootRepository } from '../src/repository.js';

const options = { baseIri: 'https://policy.example' };
const installationId = 'installation-policy-1';
const temporaryDirectories: string[] = [];

const publicScope: VisibilityScopeV1 = { version: 1, clauses: [] };
const workspaceScope: VisibilityScopeV1 = {
  version: 1,
  clauses: [[{ kind: 'workspace', workspaceId: 'workspace-1' }]],
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

interface Environment {
  db: D1DatabaseLike;
  capability: TaprootHostWriteCapability;
  close(): Promise<void>;
}

const environments: Array<{
  name: string;
  create(): Promise<Environment>;
}> = [
  {
    name: 'persisted node:sqlite',
    async create() {
      const directory = mkdtempSync(join(tmpdir(), 'taproot-policy-'));
      temporaryDirectories.push(directory);
      const path = join(directory, 'taproot.sqlite');
      let db = new NodeSqliteDatabase(path);
      await initializeTaproot(db, options);
      await db.close();
      db = new NodeSqliteDatabase(path);
      return {
        db,
        capability: await writeCapability(db),
        close: () => db.close(),
      };
    },
  },
  {
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
      return {
        db,
        capability: await writeCapability(db),
        close: () => miniflare.dispose(),
      };
    },
  },
];

for (const runtime of environments) {
  describe(`canonical policy persistence on ${runtime.name}`, () => {
    it('commits canonical revisions, exact policy history, audit handoff, and CAS atomically', async () => {
      const environment = await runtime.create();
      try {
        await bootstrapTaprootAuthorization(
          environment.db,
          options,
          environment.capability,
          installationId,
        );
        const guard = await createInstallationAuthorizationGuard(
          environment.db,
          options,
          environment.capability,
        );
        const created = await createItem(
          environment.db,
          options,
          guard,
          writeContext(1),
          {
            id: 'Q1',
            labels: { en: { language: 'en', value: 'private' } },
            authorization: policy(1, workspaceScope),
          },
        );
        expect(created).toMatchObject({
          newRevision: 1,
          authorizationRevision: 2,
          searchGeneration: 2,
        });

        const attempts = await Promise.allSettled([
          setLabel(
            environment.db,
            options,
            guard,
            writeContext(2),
            'Q1',
            'en',
            'winner-a',
            { expectedRevision: 1, authorization: policy(2, workspaceScope) },
          ),
          setLabel(
            environment.db,
            options,
            guard,
            writeContext(2),
            'Q1',
            'en',
            'winner-b',
            { expectedRevision: 1, authorization: policy(2, workspaceScope) },
          ),
        ]);
        expect(
          attempts.filter(({ status }) => status === 'fulfilled'),
        ).toHaveLength(1);
        expect(
          attempts.filter(({ status }) => status === 'rejected'),
        ).toHaveLength(1);
        const counts = await environment.db
          .prepare(
            `SELECT
              (SELECT COUNT(*) FROM taproot_entity_revisions WHERE entity_id = 'Q1') AS revisions,
              (SELECT COUNT(*) FROM taproot_entity_authorization_revisions WHERE entity_id = 'Q1') AS policies,
              (SELECT COUNT(*) FROM taproot_authorization_projection_outbox WHERE entity_id = 'Q1') AS handoffs,
              (SELECT authorization_revision FROM taproot_installation_authorization WHERE singleton = 1) AS auth_revision`,
          )
          .all<{
            revisions: number;
            policies: number;
            handoffs: number;
            auth_revision: number;
          }>();
        expect(counts.results[0]).toEqual({
          revisions: 2,
          policies: 2,
          handoffs: 2,
          auth_revision: 3,
        });
      } finally {
        await environment.close();
      }
    }, 30_000);

    it('allows only one different-entity write to advance the same installation revision', async () => {
      const environment = await runtime.create();
      try {
        await bootstrapTaprootAuthorization(
          environment.db,
          options,
          environment.capability,
          installationId,
        );
        const guard = await createInstallationAuthorizationGuard(
          environment.db,
          options,
          environment.capability,
        );
        const attempts = await Promise.allSettled([
          createItem(environment.db, options, guard, writeContext(1), {
            id: 'Q1',
            authorization: policy(1, workspaceScope),
          }),
          createItem(environment.db, options, guard, writeContext(1), {
            id: 'Q2',
            authorization: policy(1, workspaceScope),
          }),
        ]);
        expect(
          attempts.filter(({ status }) => status === 'fulfilled'),
        ).toHaveLength(1);
        expect(
          attempts.filter(({ status }) => status === 'rejected'),
        ).toHaveLength(1);
        const state = await environment.db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM taproot_entities WHERE entity_id IN ('Q1', 'Q2')) AS entities,
               authorization_revision,
               search_generation,
               last_advance_id
             FROM taproot_installation_authorization WHERE singleton = 1`,
          )
          .all<{
            entities: number;
            authorization_revision: number;
            search_generation: number;
            last_advance_id: string;
          }>();
        expect(state.results[0]).toMatchObject({
          entities: 1,
          authorization_revision: 2,
          search_generation: 2,
        });
        expect(state.results[0]!.last_advance_id).not.toBe('bootstrap');
      } finally {
        await environment.close();
      }
    }, 30_000);

    it('fails legacy rows closed and prevents explicit entity or statement widening', async () => {
      const environment = await runtime.create();
      try {
        await bootstrapTaprootAuthorization(
          environment.db,
          options,
          environment.capability,
          installationId,
        );
        const guard = await createInstallationAuthorizationGuard(
          environment.db,
          options,
          environment.capability,
        );
        await createItem(environment.db, options, guard, writeContext(1), {
          id: 'Q1',
          authorization: policy(1, workspaceScope),
        });
        await expect(
          setLabel(
            environment.db,
            options,
            guard,
            writeContext(2, true),
            'Q1',
            'en',
            'widened',
            { expectedRevision: 1, authorization: policy(2, publicScope) },
          ),
        ).rejects.toBeInstanceOf(InvalidEntityError);
        const state = await new PersistedEntityAuthorizationSource(
          environment.db,
        ).getInstallationAuthorizationState();
        expect(state.authorizationRevision).toBe(2);
        const reader = await authorizedReader(
          environment.db,
          context(2, 'principal-1', ['workspace-1']),
        );
        await expect(reader.getEntity('Q1')).resolves.toMatchObject({
          entity: { id: 'Q1', lastrevid: 1 },
        });
        await expect(
          (
            await authorizedReader(
              environment.db,
              context(2, 'principal-2', []),
            )
          ).getEntity('Q1'),
        ).rejects.toBeInstanceOf(AuthorizationDeniedError);
      } finally {
        await environment.close();
      }
    }, 30_000);

    it('intersects parent and statement restrictions and denies whole-Item hydration', async () => {
      const environment = await runtime.create();
      try {
        await bootstrapTaprootAuthorization(
          environment.db,
          options,
          environment.capability,
          installationId,
        );
        const guard = await createInstallationAuthorizationGuard(
          environment.db,
          options,
          environment.capability,
        );
        await createProperty(environment.db, options, guard, writeContext(1), {
          id: 'P1',
          datatype: 'string',
          authorization: policy(1, publicScope),
        });
        await createItem(environment.db, options, guard, writeContext(2), {
          id: 'Q1',
          authorization: policy(2, workspaceScope),
        });
        const statement = createStatement(
          'Q1',
          {
            snaktype: 'value',
            property: 'P1',
            datatype: 'string',
            datavalue: { type: 'string', value: 'restricted fact' },
          },
          'A restricted fact',
          { id: 'Q1$restricted' },
        );
        const principalScope: VisibilityScopeV1 = {
          version: 1,
          clauses: [[{ kind: 'principal', principalId: 'principal-1' }]],
        };
        await addStatement(
          environment.db,
          options,
          guard,
          writeContext(3, true),
          'Q1',
          statement,
          {
            expectedRevision: 1,
            authorization: policy(3, workspaceScope, {
              [statement.id]: [principalScope],
            }),
          },
        );
        const source = new PersistedEntityAuthorizationSource(environment.db);
        const statementPolicy = await source.getStatementAuthorization(
          'Q1',
          statement.id,
        );
        expect(statementPolicy?.visibility.clauses).toHaveLength(2);
        await expect(
          (
            await authorizedReader(
              environment.db,
              context(4, 'principal-1', ['workspace-1']),
            )
          ).getEntity('Q1'),
        ).resolves.toMatchObject({ entity: { id: 'Q1' } });
        await expect(
          (
            await authorizedReader(
              environment.db,
              context(4, 'principal-2', ['workspace-1']),
            )
          ).getEntity('Q1'),
        ).rejects.toBeInstanceOf(AuthorizationDeniedError);
      } finally {
        await environment.close();
      }
    }, 30_000);

    it('backfills quarantined legacy rows only from a bounded revision/hash-attested admin plan', async () => {
      const environment = await runtime.create();
      try {
        await new TaprootRepository(environment.db, options).createItem({
          id: 'Q1',
          labels: { en: { language: 'en', value: 'legacy private' } },
        });
        const rows = await environment.db
          .prepare(
            `SELECT entity_id, revision, content_hash
             FROM taproot_entity_revisions ORDER BY entity_id, revision`,
          )
          .all<{
            entity_id: string;
            revision: number;
            content_hash: string;
          }>();
        const revisionManifestHash = await hash(
          JSON.stringify(
            rows.results.map(({ entity_id, revision, content_hash }) => [
              entity_id,
              Number(revision),
              content_hash,
            ]),
          ),
        );
        await bootstrapLegacyTaprootAuthorization(
          environment.db,
          options,
          environment.capability,
          installationId,
          { entityCount: 1, revisionCount: 1, revisionManifestHash },
        );
        const admin = {
          ...context(1, 'principal-1', ['workspace-1']),
          capabilities: [SEARCH_ADMIN_CAPABILITY],
        };
        await expect(
          (await authorizedReader(environment.db, admin)).getEntity('Q1'),
        ).rejects.toBeInstanceOf(AuthorizationDeniedError);
        const before = await inspectTaprootAuthorizationReadiness(
          environment.db,
          options,
          environment.capability,
          admin,
        );
        expect(before).toMatchObject({
          ready: false,
          counts: { quarantinedEntities: 1 },
          issues: [
            {
              entityId: 'Q1',
              codes: ['missing-current-policy', 'missing-revision-policy'],
            },
          ],
        });
        const input = [
          {
            entityId: 'Q1' as const,
            revisions: [
              {
                revision: 1,
                contentHash: rows.results[0]!.content_hash,
                workspaceId: 'workspace-1',
                ownerPrincipalId: 'principal-1',
                visibility: workspaceScope,
                statementRestrictions: {},
              },
            ],
          },
        ];
        const winner = await planTaprootAuthorizationBackfill(
          environment.db,
          options,
          environment.capability,
          admin,
          input,
        );
        const stale = await planTaprootAuthorizationBackfill(
          environment.db,
          options,
          environment.capability,
          admin,
          input,
        );
        await applyTaprootAuthorizationBackfill(
          environment.db,
          options,
          environment.capability,
          admin,
          winner.planId,
        );
        const currentAdmin = { ...admin, authorizationRevision: 2 };
        await expect(
          applyTaprootAuthorizationBackfill(
            environment.db,
            options,
            environment.capability,
            currentAdmin,
            stale.planId,
          ),
        ).rejects.toBeInstanceOf(Error);
        await expect(
          applyTaprootAuthorizationBackfill(
            environment.db,
            options,
            environment.capability,
            currentAdmin,
            winner.planId,
          ),
        ).resolves.toMatchObject({ status: 'complete' });
        const after = await inspectTaprootAuthorizationReadiness(
          environment.db,
          options,
          environment.capability,
          currentAdmin,
        );
        expect(after).toMatchObject({
          ready: true,
          counts: { quarantinedEntities: 0 },
          issues: [],
        });
        await expect(
          (await authorizedReader(environment.db, currentAdmin)).getEntity(
            'Q1',
          ),
        ).resolves.toMatchObject({ entity: { id: 'Q1' } });
      } finally {
        await environment.close();
      }
    }, 30_000);

    it('fences and advances Workshop-owned writes in the same rollback-safe ordered batch', async () => {
      const environment = await runtime.create();
      try {
        await bootstrapTaprootAuthorization(
          environment.db,
          options,
          environment.capability,
          installationId,
        );
        const guard = await createInstallationAuthorizationGuard(
          environment.db,
          options,
          environment.capability,
        );
        await environment.db.batch([
          environment.db.prepare(
            `CREATE TABLE workshop_guard_probe(
               id TEXT PRIMARY KEY, value TEXT NOT NULL
             ) STRICT`,
          ),
        ]);
        const rolledBack = await guard.prepareAuthorizationAdvance(
          writeContext(1),
          {
            advanceId: 'advance-rollback',
            domain: 'workshop',
            reason: 'task policy create',
          },
        );
        await expect(
          environment.db.batch([
            ...rolledBack.statements,
            environment.db
              .prepare(
                `INSERT INTO workshop_guard_probe(id, value) VALUES (?, ?)`,
              )
              .bind('rolled-back', 'secret task'),
            environment.db.prepare(
              `INSERT INTO taproot_assertions(assertion_key) SELECT NULL`,
            ),
          ]),
        ).rejects.toBeInstanceOf(Error);
        expect(await guard.readCurrentState()).toMatchObject({
          authorizationRevision: 1,
          searchGeneration: 1,
        });

        const left = await guard.prepareAuthorizationAdvance(writeContext(1), {
          advanceId: 'advance-left',
          domain: 'workshop',
          reason: 'task policy create',
        });
        const right = await guard.prepareAuthorizationAdvance(writeContext(1), {
          advanceId: 'advance-right',
          domain: 'workshop',
          reason: 'task policy create',
        });
        const outcomes = await Promise.allSettled([
          environment.db.batch([
            ...left.statements,
            environment.db
              .prepare(
                `INSERT INTO workshop_guard_probe(id, value) VALUES (?, ?)`,
              )
              .bind('left', 'task'),
          ]),
          environment.db.batch([
            ...right.statements,
            environment.db
              .prepare(
                `INSERT INTO workshop_guard_probe(id, value) VALUES (?, ?)`,
              )
              .bind('right', 'task'),
          ]),
        ]);
        expect(
          outcomes.filter(({ status }) => status === 'fulfilled'),
        ).toHaveLength(1);
        const proof = await environment.db
          .prepare(
            `SELECT
              (SELECT COUNT(*) FROM workshop_guard_probe) AS domain_rows,
              (SELECT COUNT(*) FROM taproot_installation_authorization_advances) AS audits,
              (SELECT authorization_revision FROM taproot_installation_authorization WHERE singleton = 1) AS revision`,
          )
          .all<{ domain_rows: number; audits: number; revision: number }>();
        expect(proof.results[0]).toEqual({
          domain_rows: 1,
          audits: 1,
          revision: 2,
        });
      } finally {
        await environment.close();
      }
    }, 30_000);
  });
}

function policy(
  expectedAuthorizationRevision: number,
  visibility: VisibilityScopeV1,
  statementRestrictions: CanonicalAuthorizationPolicyInput['statementRestrictions'] = {},
): CanonicalAuthorizationPolicyInput {
  return {
    installationId,
    workspaceId: 'workspace-1',
    ownerPrincipalId: 'principal-1',
    visibility,
    statementRestrictions,
    expectedAuthorizationRevision,
  };
}

function context(
  authorizationRevision: number,
  principalId: string,
  workspaceIds: string[],
): AuthorizationContext {
  return {
    installationId,
    principalId,
    activeWorkspaceId: workspaceIds[0] ?? null,
    workspaceIds,
    capabilities: [],
    authorizationRevision,
  };
}

function writeContext(
  authorizationRevision: number,
  policyAuthority = false,
): AuthorizationContext {
  return {
    ...context(authorizationRevision, 'principal-1', ['workspace-1']),
    capabilities: [
      KNOWLEDGE_WRITE_CAPABILITY,
      ...(policyAuthority ? [KNOWLEDGE_POLICY_CAPABILITY] : []),
    ],
  };
}

async function writeCapability(db: D1DatabaseLike) {
  const key = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return createTaprootHostWriteCapability(db, options, key);
}

async function authorizedReader(
  db: D1DatabaseLike,
  authorizationContext: AuthorizationContext,
) {
  return createAuthorizedTaproot(db, options, authorizationContext, {
    cursorCodec: createAuthorizationCursorCodec(
      await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]),
    ),
  });
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
