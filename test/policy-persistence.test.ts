import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import type { D1DatabaseLike, D1PreparedStatementLike } from '@gnolith/diamond';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthorizationDeniedError,
  InvalidAuthorizationError,
  InvalidEntityError,
  RevisionConflictError,
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
  createInstallationDomainMutationGuard,
  importEntities,
  initializeTaproot,
  inspectTaprootSchema,
  inspectTaprootAuthorizationReadiness,
  planTaprootAuthorizationBackfill,
  applyTaprootAuthorizationBackfill,
  setLabel,
  redirectEntity,
  replaceEntity,
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
        const rejection = attempts.find(({ status }) => status === 'rejected');
        if (rejection?.status === 'rejected')
          expect(rejection.reason).toBeInstanceOf(RevisionConflictError);
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

    it('denies inaccessible bulk upserts before canonical hydration', async () => {
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
        await environment.db
          .prepare(
            `UPDATE taproot_entities SET entity_json = '{}'
             WHERE entity_id = 'Q1'`,
          )
          .run();
        const outsider: AuthorizationContext = {
          ...context(2, 'principal-outside', []),
          capabilities: [KNOWLEDGE_WRITE_CAPABILITY],
        };
        const deniedExisting = await importEntities(
          environment.db,
          options,
          guard,
          outsider,
          [importedItem('Q1')],
          {
            mode: 'upsert',
            authorizations: { Q1: policy(2, workspaceScope) },
          },
        );
        const deniedMissing = await importEntities(
          environment.db,
          options,
          guard,
          outsider,
          [importedItem('Q2')],
          {
            mode: 'upsert',
            authorizations: { Q2: policy(2, workspaceScope) },
          },
        );
        for (const denied of [deniedExisting, deniedMissing]) {
          expect(denied.succeeded).toEqual([]);
          expect(denied.failed[0]?.error).toBeInstanceOf(
            AuthorizationDeniedError,
          );
          expect(denied.failed[0]?.error.message).toBe('Authorization denied');
        }
        expect(await guard.readCurrentState()).toMatchObject({
          authorizationRevision: 2,
          searchGeneration: 2,
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
        await createItem(environment.db, options, guard, writeContext(3), {
          id: 'Q2',
          authorization: policy(3, workspaceScope),
        });
        const admin: AuthorizationContext = {
          ...context(4, 'principal-1', ['workspace-1']),
          capabilities: [SEARCH_ADMIN_CAPABILITY],
        };
        await environment.db
          .prepare(
            `UPDATE taproot_entity_authorization
             SET visibility_json = '{"version":1,"clauses":[]}',
                 effective_visibility_json = '{"version":1,"clauses":[]}'
             WHERE entity_id = 'Q2'`,
          )
          .run();
        const source = new PersistedEntityAuthorizationSource(environment.db);
        await expect(source.getEntityAuthorization('Q2')).resolves.toBeNull();
        const widened = await inspectTaprootAuthorizationReadiness(
          environment.db,
          options,
          environment.capability,
          admin,
        );
        expect(widened.ready).toBe(false);
        expect(widened.counts.currentHistoryParityMismatches).toBeGreaterThan(
          0,
        );
        await environment.db
          .prepare(
            `UPDATE taproot_statement_authorization
             SET authorization_revision = authorization_revision - 1,
                 effective_visibility_json = '{"version":1,"clauses":[]}'
             WHERE entity_id = 'Q1' AND statement_id = 'Q1$fact'`,
          )
          .run();
        await expect(
          source.getStatementAuthorization('Q1', statement.id),
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
        await environment.db
          .prepare(
            `UPDATE taproot_entity_authorization
             SET authorization_revision = 0 WHERE entity_id = 'Q1'`,
          )
          .run();
        await expect(
          new PersistedEntityAuthorizationSource(
            environment.db,
          ).getEntityAuthorization('Q1'),
        ).resolves.toBeNull();
        const invalidRevision = await inspectTaprootAuthorizationReadiness(
          environment.db,
          options,
          environment.capability,
          admin,
        );
        expect(invalidRevision.ready).toBe(false);
        expect(invalidRevision.counts.quarantinedEntities).toBeGreaterThan(0);
        expect(invalidRevision.counts.entityPolicyMismatches).toBeGreaterThan(
          0,
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

        const guard = await createInstallationAuthorizationGuard(
          environment.db,
          options,
          environment.capability,
        );
        await createItem(environment.db, options, guard, writeContext(1), {
          id: 'Q1',
          authorization: policy(1, publicScope),
        });
        await expect(
          environment.db
            .prepare(
              `INSERT OR REPLACE INTO taproot_entity_revisions(
                 entity_id, revision, entity_json, actor, attribution_json,
                 edit_summary, tags_json, event_id, content_hash, parent_hash,
                 deleted_at, redirect_to, created_at
               )
               SELECT entity_id, revision, entity_json, actor, attribution_json,
                      'tampered', tags_json, event_id, 'tampered-hash', parent_hash,
                      deleted_at, redirect_to, created_at
               FROM taproot_entity_revisions
               WHERE entity_id = 'Q1' AND revision = 1`,
            )
            .run(),
        ).rejects.toBeInstanceOf(Error);
        await expect(
          environment.db
            .prepare(
              `INSERT OR REPLACE INTO taproot_audit_events
               SELECT event_id, entity_id, revision, event_type,
                      attribution_json, 'tampered', tags_json, request_id,
                      'tampered-hash', parent_hash, details_json, created_at
               FROM taproot_audit_events WHERE entity_id = 'Q1'`,
            )
            .run(),
        ).rejects.toBeInstanceOf(Error);
        const q1Event = await environment.db
          .prepare(
            `SELECT event_id FROM taproot_entity_authorization_revisions
             WHERE entity_id = 'Q1' AND source_revision = 1`,
          )
          .all<{ event_id: string }>();
        await environment.db.batch([
          environment.db.prepare(
            `INSERT INTO taproot_entities(
               entity_id, entity_type, revision, entity_json
             ) VALUES ('Q999', 'item', 1,
               '{"id":"Q999","type":"item","labels":{},"descriptions":{},"aliases":{},"claims":{},"sitelinks":{},"lastrevid":1,"modified":"2026-07-21T00:00:00.000Z"}')`,
          ),
          environment.db.prepare(
            `INSERT INTO taproot_entity_revisions(
               entity_id, revision, entity_json, event_id, content_hash, tags_json
             ) SELECT entity_id, revision, entity_json, 'q999-event', 'q999-hash', '[]'
               FROM taproot_entities WHERE entity_id = 'Q999'`,
          ),
        ]);
        await expect(
          environment.db
            .prepare(
              `INSERT OR REPLACE INTO taproot_entity_authorization_revisions(
                 entity_id, source_revision, installation_id, workspace_id,
                 owner_principal_id, visibility_json, effective_visibility_json,
                 authorization_revision, event_id, created_at
               ) VALUES ('Q999', 1, ?, NULL, 'principal-1',
                 '{"version":1,"clauses":[]}', '{"version":1,"clauses":[]}',
                 2, ?, 'now')`,
            )
            .bind(installationId, q1Event.results[0]!.event_id)
            .run(),
        ).rejects.toBeInstanceOf(Error);

        await environment.db.batch([
          environment.db.prepare(
            `DROP TRIGGER taproot_entity_authorization_revisions_no_replace`,
          ),
          environment.db.prepare(
            `CREATE TRIGGER taproot_entity_authorization_revisions_no_replace
             BEFORE INSERT ON taproot_entity_authorization_revisions
             WHEN 0 BEGIN SELECT 1; END`,
          ),
        ]);
        const weakTrigger = await inspectTaprootSchema(environment.db);
        expect(weakTrigger.valid).toBe(false);
        expect(weakTrigger.errors).toContain(
          'taproot_entity_authorization_revisions_no_replace definition does not match the package catalog',
        );
        await environment.db.batch([
          environment.db.prepare(
            `DROP TRIGGER taproot_entity_authorization_revisions_no_replace`,
          ),
          environment.db.prepare(
            `CREATE TRIGGER taproot_entity_authorization_revisions_no_replace
             BEFORE INSERT ON taproot_entity_authorization_revisions
             WHEN EXISTS (
               SELECT 1 FROM taproot_entity_authorization_revisions
               WHERE (entity_id = NEW.entity_id AND source_revision = NEW.source_revision)
                  OR event_id = NEW.event_id
             )
             BEGIN SELECT RAISE(ABORT, 'taproot authorization revisions cannot be replaced'); END`,
          ),
        ]);

        await environment.db.batch([
          environment.db.prepare(
            `DROP INDEX taproot_statement_authorization_candidate_idx`,
          ),
          environment.db.prepare(`DROP TABLE taproot_statement_authorization`),
          environment.db.prepare(
            `CREATE TABLE taproot_statement_authorization(
               entity_id TEXT, statement_id TEXT, source_revision TEXT,
               restrictions_json TEXT, effective_visibility_json TEXT,
               authorization_revision TEXT
             ) STRICT`,
          ),
          environment.db.prepare(
            `CREATE INDEX taproot_statement_authorization_candidate_idx
             ON taproot_statement_authorization(entity_id, source_revision, statement_id)`,
          ),
        ]);
        const schema = await inspectTaprootSchema(environment.db);
        expect(schema.valid).toBe(false);
        expect(schema.errors).toContain(
          'taproot_statement_authorization definition does not match the package catalog',
        );
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
        await replaceEntity(
          environment.db,
          options,
          guard,
          writeContext(4, true),
          'Q1',
          importedItem('Q1'),
          {
            expectedRevision: 2,
            statementTexts: {},
            authorization: policy(4, workspaceScope),
          },
        );
        await environment.db.batch([
          environment.db.prepare(
            `DROP TRIGGER taproot_entity_authorization_revisions_no_update`,
          ),
          environment.db.prepare(
            `UPDATE taproot_entity_authorization_revisions
             SET effective_visibility_json = '{"version":1,"clauses":[]}'
             WHERE entity_id = 'Q1' AND source_revision = 2`,
          ),
          environment.db.prepare(
            `CREATE TRIGGER taproot_entity_authorization_revisions_no_update
             BEFORE UPDATE ON taproot_entity_authorization_revisions
             BEGIN SELECT RAISE(ABORT, 'taproot authorization revisions are immutable'); END`,
          ),
        ]);
        await expect(
          source.getEntityRevisionAuthorization('Q1', 2),
        ).resolves.toBeNull();
        const corruptedHistory = await inspectTaprootAuthorizationReadiness(
          environment.db,
          options,
          environment.capability,
          {
            ...context(5, 'principal-1', ['workspace-1']),
            capabilities: [SEARCH_ADMIN_CAPABILITY],
          },
        );
        expect(corruptedHistory.ready).toBe(false);
        expect(corruptedHistory.counts.entityPolicyMismatches).toBeGreaterThan(
          0,
        );
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

    it('keeps knowledge advances policy-authorized and rollback-safe', async () => {
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
            { advanceId: 'write-only-denied', reason: 'policy change' },
            [
              environment.db
                .prepare(
                  `INSERT INTO workshop_guard_probe(id, value) VALUES (?, ?)`,
                )
                .bind('write-only-denied', 'not committed'),
            ],
          ),
        ).rejects.toBeInstanceOf(InvalidAuthorizationError);
        await expect(
          guard.batchWithAuthorizationAdvance(
            writeContext(1, true),
            {
              advanceId: 'advance-rollback',
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
            writeContext(1, true),
            {
              advanceId: 'advance-left',
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
            writeContext(1, true),
            {
              advanceId: 'advance-right',
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

    it('fences exact Task and Memory capabilities without counter advances', async () => {
      const environment = await runtime.create();
      try {
        await bootstrapTaprootAuthorization(
          environment.db,
          options,
          environment.capability,
          installationId,
        );
        const taskGuard = await createInstallationDomainMutationGuard(
          environment.db,
          options,
          environment.capability,
          { domain: 'workshop.task', capability: 'task-write' },
        );
        const memoryGuard = await createInstallationDomainMutationGuard(
          environment.db,
          options,
          environment.capability,
          { domain: 'workshop.memory', capability: 'memory-write' },
        );
        await environment.db
          .prepare(
            `CREATE TABLE workshop_domain_probe(
               id TEXT PRIMARY KEY, domain TEXT NOT NULL
             ) STRICT`,
          )
          .run();
        const taskContext: AuthorizationContext = {
          ...context(1, 'task-agent', ['workspace-1']),
          capabilities: ['task-write'],
        };
        const memoryContext: AuthorizationContext = {
          ...context(1, 'memory-agent', ['workspace-1']),
          capabilities: ['memory-write'],
        };
        const task = await taskGuard.batchWithExpectedRevision(taskContext, [
          environment.db.prepare(
            `INSERT INTO workshop_domain_probe(id, domain)
               VALUES ('task-ok', 'task') RETURNING id`,
          ),
        ]);
        const memory = await memoryGuard.batchWithExpectedRevision(
          memoryContext,
          [
            environment.db.prepare(
              `INSERT INTO workshop_domain_probe(id, domain)
               VALUES ('memory-ok', 'memory') RETURNING id`,
            ),
          ],
        );
        expect(task).toMatchObject({
          authorizationRevision: 1,
          searchGeneration: 1,
          results: [{ results: [{ id: 'task-ok' }] }],
        });
        expect(memory).toMatchObject({
          authorizationRevision: 1,
          searchGeneration: 1,
          results: [{ results: [{ id: 'memory-ok' }] }],
        });
        for (const [guard, deniedContext, id] of [
          [memoryGuard, taskContext, 'task-on-memory'],
          [taskGuard, memoryContext, 'memory-on-task'],
          [taskGuard, writeContext(1), 'knowledge-on-task'],
          [memoryGuard, writeContext(1), 'knowledge-on-memory'],
          [
            taskGuard,
            { ...taskContext, installationId: 'other-installation' },
            'cross-installation',
          ],
          [taskGuard, { ...taskContext, authorizationRevision: 0 }, 'stale'],
        ] as const) {
          await expect(
            guard.batchWithExpectedRevision(deniedContext, [
              environment.db
                .prepare(
                  `INSERT INTO workshop_domain_probe(id, domain) VALUES (?, 'denied')`,
                )
                .bind(id),
            ]),
          ).rejects.toBeInstanceOf(InvalidAuthorizationError);
        }
        await expect(
          taskGuard.batchWithExpectedRevision(taskContext, [
            environment.db.prepare(
              `INSERT INTO workshop_domain_probe(id, domain)
               VALUES ('rolled-back', 'task')`,
            ),
            environment.db.prepare(
              `INSERT INTO taproot_assertions(assertion_key) SELECT NULL`,
            ),
          ]),
        ).rejects.toBeInstanceOf(Error);
        const proof = await environment.db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM workshop_domain_probe) AS domain_rows,
               authorization_revision, search_generation
             FROM taproot_installation_authorization WHERE singleton = 1`,
          )
          .all<{
            domain_rows: number;
            authorization_revision: number;
            search_generation: number;
          }>();
        expect(proof.results[0]).toEqual({
          domain_rows: 2,
          authorization_revision: 1,
          search_generation: 1,
        });
      } finally {
        await environment.close();
      }
    }, 30_000);

    it('binds counter advances to the previously read durable advance id', async () => {
      const environment = await runtime.create();
      try {
        await bootstrapTaprootAuthorization(
          environment.db,
          options,
          environment.capability,
          installationId,
        );
        let interposedAdvanceId: string | null = null;
        const db: D1DatabaseLike = {
          prepare: (sql) => environment.db.prepare(sql),
          batch: async <T = Record<string, unknown>>(
            statements: D1PreparedStatementLike[],
          ) => {
            if (interposedAdvanceId !== null) {
              const advanceId = interposedAdvanceId;
              interposedAdvanceId = null;
              await environment.db
                .prepare(
                  `UPDATE taproot_installation_authorization
                   SET last_advance_id = ? WHERE singleton = 1`,
                )
                .bind(advanceId)
                .run();
            }
            return environment.db.batch<T>(statements);
          },
        };
        const capability = await writeCapability(db);
        const guard = await createInstallationAuthorizationGuard(
          db,
          options,
          capability,
        );
        await environment.db
          .prepare(`CREATE TABLE advance_aba_probe(id TEXT PRIMARY KEY) STRICT`)
          .run();
        interposedAdvanceId = 'interposed-advance';
        await expect(
          guard.batchWithAuthorizationAdvance(
            writeContext(1, true),
            { advanceId: 'attempted-advance', reason: 'policy update' },
            [
              db.prepare(
                `INSERT INTO advance_aba_probe(id) VALUES ('advance')`,
              ),
            ],
          ),
        ).rejects.toBeInstanceOf(Error);
        interposedAdvanceId = 'interposed-canonical';
        await expect(
          createItem(db, options, guard, writeContext(1), {
            id: 'Q1',
            authorization: policy(1, publicScope),
          }),
        ).rejects.toBeInstanceOf(Error);
        const proof = await environment.db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM advance_aba_probe) AS domain_rows,
               (SELECT COUNT(*) FROM taproot_entities) AS entities,
               authorization_revision, search_generation, last_advance_id
             FROM taproot_installation_authorization WHERE singleton = 1`,
          )
          .all<{
            domain_rows: number;
            entities: number;
            authorization_revision: number;
            search_generation: number;
            last_advance_id: string;
          }>();
        expect(proof.results[0]).toEqual({
          domain_rows: 0,
          entities: 0,
          authorization_revision: 1,
          search_generation: 1,
          last_advance_id: 'interposed-canonical',
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
