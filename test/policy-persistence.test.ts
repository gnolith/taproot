import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import type { D1DatabaseLike } from '@gnolith/diamond';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthorizationDeniedError,
  InvalidAuthorizationError,
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
  importEntities,
  initializeTaproot,
  inspectTaprootSchema,
  inspectTaprootAuthorizationReadiness,
  planTaprootAuthorizationBackfill,
  applyTaprootAuthorizationBackfill,
  setLabel,
  redirectEntity,
  restoreEntity,
  revertEntity,
  softDeleteEntity,
  type AuthorizationContext,
  type CanonicalAuthorizationPolicyInput,
  type TaprootHostWriteCapability,
  type VisibilityScopeV1,
  type WikibaseEntity,
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

    it('rejects runtime policy omission with zero canonical or authorization side effects', async () => {
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
        const incomplete = { id: 'Q1' } as unknown as Parameters<
          typeof createItem
        >[4];
        expect(() =>
          createItem(
            environment.db,
            options,
            guard,
            writeContext(1),
            incomplete,
          ),
        ).toThrow(InvalidAuthorizationError);
        const proof = await environment.db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM taproot_entities) AS entities,
               (SELECT COUNT(*) FROM taproot_entity_revisions) AS revisions,
               (SELECT COUNT(*) FROM taproot_audit_events) AS audits,
               (SELECT COUNT(*) FROM taproot_entity_authorization) AS policies,
               (SELECT COUNT(*) FROM taproot_authorization_projection_outbox) AS outbox,
               authorization_revision, search_generation
             FROM taproot_installation_authorization WHERE singleton = 1`,
          )
          .all<Record<string, number>>();
        expect(proof.results[0]).toMatchObject({
          entities: 0,
          revisions: 0,
          audits: 0,
          policies: 0,
          outbox: 0,
          authorization_revision: 1,
          search_generation: 1,
        });
      } finally {
        await environment.close();
      }
    }, 30_000);

    it('sequences shared authorization revisions across multi-entity bulk import', async () => {
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
        const result = await importEntities(
          environment.db,
          options,
          guard,
          writeContext(1),
          [importedItem('Q1'), importedItem('Q2')],
          {
            authorizations: {
              Q1: policy(1, publicScope),
              Q2: policy(2, publicScope),
            },
          },
        );
        expect(result.failed).toEqual([]);
        expect(result.succeeded).toHaveLength(2);
        expect(await guard.readCurrentState()).toMatchObject({
          authorizationRevision: 3,
          searchGeneration: 3,
        });
      } finally {
        await environment.close();
      }
    }, 30_000);

    it('preauthorizes mutations and every redirect target before canonical hydration', async () => {
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
          authorization: policy(1, publicScope),
        });
        await createItem(environment.db, options, guard, writeContext(2), {
          id: 'Q2',
          authorization: policy(2, workspaceScope),
        });
        const deniedWriter: AuthorizationContext = {
          ...context(3, 'principal-2', []),
          capabilities: [KNOWLEDGE_WRITE_CAPABILITY],
        };
        await expect(
          setLabel(
            environment.db,
            options,
            guard,
            deniedWriter,
            'Q2',
            'en',
            'oracle',
            { expectedRevision: 999, authorization: policy(3, workspaceScope) },
          ),
        ).rejects.toMatchObject({
          name: 'AuthorizationDeniedError',
          message: 'Authorization denied',
        });
        await expect(
          setLabel(
            environment.db,
            options,
            guard,
            deniedWriter,
            'Q999',
            'en',
            'oracle',
            { expectedRevision: 999, authorization: policy(3, workspaceScope) },
          ),
        ).rejects.toMatchObject({
          name: 'AuthorizationDeniedError',
          message: 'Authorization denied',
        });
        await expect(
          redirectEntity(
            environment.db,
            options,
            guard,
            deniedWriter,
            'Q1',
            'Q2',
            { expectedRevision: 1, authorization: policy(3, publicScope) },
          ),
        ).rejects.toBeInstanceOf(AuthorizationDeniedError);
        const source = await environment.db
          .prepare(
            `SELECT redirect_to FROM taproot_entities WHERE entity_id = 'Q1'`,
          )
          .all<{ redirect_to: string | null }>();
        expect(source.results[0]?.redirect_to).toBeNull();
      } finally {
        await environment.close();
      }
    }, 30_000);

    it('rejects reverted redirects whose current target is deleted', async () => {
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
          authorization: policy(1, publicScope),
        });
        await createItem(environment.db, options, guard, writeContext(2), {
          id: 'Q2',
          authorization: policy(2, publicScope),
        });
        await redirectEntity(
          environment.db,
          options,
          guard,
          writeContext(3),
          'Q1',
          'Q2',
          { expectedRevision: 1, authorization: policy(3, publicScope) },
        );
        await restoreEntity(
          environment.db,
          options,
          guard,
          writeContext(4),
          'Q1',
          { expectedRevision: 2, authorization: policy(4, publicScope) },
        );
        await softDeleteEntity(
          environment.db,
          options,
          guard,
          writeContext(5),
          'Q2',
          { expectedRevision: 1, authorization: policy(5, publicScope) },
        );
        await expect(
          revertEntity(
            environment.db,
            options,
            guard,
            writeContext(6),
            'Q1',
            2,
            {
              expectedRevision: 3,
              statementTexts: {},
              authorization: policy(6, publicScope),
            },
          ),
        ).rejects.toBeInstanceOf(InvalidEntityError);
        expect(await guard.readCurrentState()).toMatchObject({
          authorizationRevision: 6,
        });
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

    it('returns historical policy intersected with the current canonical scope', async () => {
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
          authorization: policy(1, publicScope),
        });
        await setLabel(
          environment.db,
          options,
          guard,
          writeContext(2, true),
          'Q1',
          'en',
          'narrowed',
          { expectedRevision: 1, authorization: policy(2, workspaceScope) },
        );
        const historical = await new PersistedEntityAuthorizationSource(
          environment.db,
        ).getEntityRevisionAuthorization('Q1', 1);
        expect(historical?.visibility).toEqual(workspaceScope);
      } finally {
        await environment.close();
      }
    }, 30_000);

    it('detects current statement-policy corruption in readiness and source lookups', async () => {
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
        const statement = createStatement(
          'Q1',
          {
            snaktype: 'value',
            property: 'P1',
            datatype: 'string',
            datavalue: { type: 'string', value: 'fact' },
          },
          'A fact.',
          { id: 'Q1$fact' },
        );
        await createItem(environment.db, options, guard, writeContext(2), {
          id: 'Q1',
          claims: { P1: [statement] },
          authorization: policy(2, publicScope, { [statement.id]: [] }),
        });
        const admin: AuthorizationContext = {
          ...context(3, 'principal-1', ['workspace-1']),
          capabilities: [SEARCH_ADMIN_CAPABILITY],
        };
        await environment.db
          .prepare(
            `UPDATE taproot_statement_authorization
             SET source_revision = source_revision - 1
             WHERE entity_id = 'Q1' AND statement_id = 'Q1$fact'`,
          )
          .run();
        await expect(
          new PersistedEntityAuthorizationSource(
            environment.db,
          ).getStatementAuthorization('Q1', statement.id),
        ).resolves.toBeNull();
        const readiness = await inspectTaprootAuthorizationReadiness(
          environment.db,
          options,
          environment.capability,
          admin,
        );
        expect(readiness.ready).toBe(false);
        expect(readiness.counts.statementPolicyMismatches).toBeGreaterThan(0);
        expect(readiness.issues[0]?.entityId).toBe('Q1');
        expect(readiness.issues[0]?.codes).toContain(
          'statement-policy-mismatch',
        );
      } finally {
        await environment.close();
      }
    }, 30_000);

    it('blocks replace-style immutable authorization rewrites and malformed schema readiness', async () => {
      const environment = await runtime.create();
      try {
        await bootstrapTaprootAuthorization(
          environment.db,
          options,
          environment.capability,
          installationId,
        );
        await expect(
          environment.db
            .prepare(
              `INSERT OR REPLACE INTO taproot_installation_authorization(
                 singleton, installation_id, authorization_revision,
                 search_generation, last_advance_id, created_at, updated_at
               ) VALUES (1, 'replacement', 1, 1, 'replacement', 'now', 'now')`,
            )
            .run(),
        ).rejects.toBeInstanceOf(Error);
        const identity = await environment.db
          .prepare(
            `SELECT installation_id FROM taproot_installation_authorization
             WHERE singleton = 1`,
          )
          .all<{ installation_id: string }>();
        expect(identity.results[0]?.installation_id).toBe(installationId);

        await environment.db.batch([
          environment.db.prepare(
            `DROP INDEX taproot_statement_authorization_candidate_idx`,
          ),
          environment.db.prepare(`DROP TABLE taproot_statement_authorization`),
          environment.db.prepare(
            `CREATE TABLE taproot_statement_authorization(only_column TEXT) STRICT`,
          ),
          environment.db.prepare(
            `CREATE INDEX taproot_statement_authorization_candidate_idx
             ON taproot_statement_authorization(only_column)`,
          ),
        ]);
        const schema = await inspectTaprootSchema(environment.db);
        expect(schema.valid).toBe(false);
        expect(schema.errors).toEqual([
          expect.stringContaining(
            'taproot_statement_authorization columns are',
          ),
        ]);
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
        await expect(
          guard.batchWithAuthorizationAdvance(
            writeContext(1),
            {
              advanceId: 'advance-rollback',
              domain: 'workshop',
              reason: 'task policy create',
            },
            [
              environment.db
                .prepare(
                  `INSERT INTO workshop_guard_probe(id, value) VALUES (?, ?)`,
                )
                .bind('rolled-back', 'secret task'),
              environment.db.prepare(
                `INSERT INTO taproot_assertions(assertion_key) SELECT NULL`,
              ),
            ],
          ),
        ).rejects.toBeInstanceOf(Error);
        expect(await guard.readCurrentState()).toMatchObject({
          authorizationRevision: 1,
          searchGeneration: 1,
        });

        const outcomes = await Promise.allSettled([
          guard.batchWithAuthorizationAdvance(
            writeContext(1),
            {
              advanceId: 'advance-left',
              domain: 'workshop',
              reason: 'task policy create',
            },
            [
              environment.db
                .prepare(
                  `INSERT INTO workshop_guard_probe(id, value) VALUES (?, ?)`,
                )
                .bind('left', 'task'),
            ],
          ),
          guard.batchWithAuthorizationAdvance(
            writeContext(1),
            {
              advanceId: 'advance-right',
              domain: 'workshop',
              reason: 'task policy create',
            },
            [
              environment.db
                .prepare(
                  `INSERT INTO workshop_guard_probe(id, value) VALUES (?, ?)`,
                )
                .bind('right', 'task'),
            ],
          ),
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

function importedItem(id: `Q${number}`): WikibaseEntity {
  return {
    id,
    type: 'item',
    labels: {},
    descriptions: {},
    aliases: {},
    claims: {},
    sitelinks: {},
    lastrevid: 1,
    modified: '2026-07-21T00:00:00.000Z',
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
