import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import type { D1DatabaseLike } from '@gnolith/diamond';
import { Miniflare } from 'miniflare';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AuthorizationDeniedError,
  commitAuthorizationAdministrationV1,
  commitAuthorizationBootstrapV1,
  createAuthorizationCursorCodec,
  createAuthorizedTaproot,
  createTaprootWorkshopPortV1,
  createTaprootHostWriteCapability,
  EntityNotFoundError,
  initializeTaproot,
  InvalidAuthorizationError,
  InvalidEntityError,
  KNOWLEDGE_POLICY_CAPABILITY,
  KNOWLEDGE_WRITE_CAPABILITY,
  prepareAuthorizationAdministrationV1,
  prepareAuthorizationBootstrapV1,
  registerAuthorizationAdministrationOwnerV1,
  registerAuthorizationBootstrapOwnerV1,
  RevisionConflictError,
  type AuthorizationContext,
  type AuthorizationAdministrationCommandV1,
  type AuthorizationAdministrationInputV1,
  type Statement,
} from '../src/index.js';

describe('sealed authorization administration owner protocol', () => {
  it('atomically applies owner-or-reader CNF visibility to rich Q1@3 and clean Q2@1, replays safely, rejects owner-and-reader, and filters after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'taproot-visibility-admin-'));
    const databasePath = join(directory, 'taproot.sqlite');
    let db = new NodeSqliteDatabase(databasePath);
    const options = { baseIri: 'https://visibility-admin.example' };
    const installationId = 'installation-1';
    try {
      await initializeTaproot(db, options);
      const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      let authority = createTaprootHostWriteCapability(db, options, key);
      const bootstrapOwner = await registerAuthorizationBootstrapOwnerV1(
        db,
        options,
        authority,
        {
          installationId,
          ownerRegistrationId: 'bootstrap',
          adapter: {
            kind: 'taproot-authorization-bootstrap-owner-adapter-v1',
            prepare: () => Promise.resolve({ statements: [], receipt: {} }),
          },
        },
      );
      const bootstrap = await prepareAuthorizationBootstrapV1(
        db,
        options,
        authority,
        {
          installationId,
          baseIri: options.baseIri,
          principalId: 'administrator',
          workspaceId: 'workspace-1',
          grants: [
            KNOWLEDGE_POLICY_CAPABILITY,
            'knowledge:read',
            KNOWLEDGE_WRITE_CAPABILITY,
            'search:admin',
          ],
          idempotencyKey: 'bootstrap',
        },
      );
      await commitAuthorizationBootstrapV1(
        bootstrap,
        await bootstrapOwner.seal(bootstrap, {}),
      );
      let port = await createTaprootWorkshopPortV1(db, options, authority, {
        installationId,
      });
      let context = await port.resolveAuthorization({
        principalId: 'administrator',
        activeWorkspaceId: 'workspace-1',
      });
      const owner = await registerAuthorizationAdministrationOwnerV1(
        db,
        options,
        authority,
        {
          installationId,
          ownerRegistrationId: 'visibility-owner',
          adapter: {
            kind: 'taproot-authorization-administration-owner-adapter-v1',
            prepare: () => Promise.resolve({ statements: [], receipt: {} }),
          },
        },
      );
      const commit = async (
        command: AuthorizationAdministrationCommandV1,
        idempotencyKey: string,
      ) => {
        context = await port.resolveAuthorization({
          principalId: 'administrator',
          activeWorkspaceId: 'workspace-1',
        });
        const input: AuthorizationAdministrationInputV1 = {
          installationId,
          expectedAuthorizationRevision: context.authorizationRevision,
          idempotencyKey,
          command,
        };
        const participant = await prepareAuthorizationAdministrationV1(
          db,
          options,
          authority,
          input,
          context,
        );
        return {
          context,
          input,
          receipt: await commitAuthorizationAdministrationV1(
            participant,
            await owner.seal(participant, {}),
          ),
        };
      };
      await commit(
        { type: 'put-principal', principalId: 'reader' },
        'register-reader',
      );
      await commit(
        { type: 'put-principal', principalId: 'outsider' },
        'register-outsider',
      );
      await commit(
        {
          type: 'put-grant',
          principalId: 'reader',
          workspaceId: 'workspace-1',
          capability: 'knowledge:read',
          granted: true,
        },
        'grant-reader',
      );
      context = await port.resolveAuthorization({
        principalId: 'administrator',
        activeWorkspaceId: 'workspace-1',
      });
      await port.createProperty(
        { id: 'P1', datatype: 'string' },
        { idempotencyKey: 'create-p1' },
        context,
      );
      context = await port.resolveAuthorization({
        principalId: 'administrator',
        activeWorkspaceId: 'workspace-1',
      });
      await port.createItem(
        { id: 'Q1' },
        { idempotencyKey: 'create-q1' },
        context,
      );
      context = await port.resolveAuthorization({
        principalId: 'administrator',
        activeWorkspaceId: 'workspace-1',
      });
      const statement: Statement = {
        id: 'Q1$rich',
        type: 'statement',
        text: 'Reader-visible statement',
        rank: 'normal',
        mainsnak: {
          snaktype: 'value',
          property: 'P1',
          datatype: 'string',
          datavalue: { type: 'string', value: 'rich' },
        },
        qualifiers: {},
        'qualifiers-order': [],
        references: [],
      };
      await port.mutateEntity(
        'Q1',
        [
          {
            command: { type: 'set-label', language: 'en', value: 'Rich one' },
            authoredText: 'Set the rich item label.',
          },
          {
            command: { type: 'add-statement', statement },
            authoredText: 'Add the rich item statement.',
          },
        ],
        { expectedRevision: 1, idempotencyKey: 'q1-2' },
        context,
      );
      context = await port.resolveAuthorization({
        principalId: 'administrator',
        activeWorkspaceId: 'workspace-1',
      });
      await port.mutateEntity(
        'Q1',
        [
          {
            command: {
              type: 'set-description',
              language: 'en',
              value: 'Rich revision three',
            },
            authoredText: 'Advance the rich item to revision three.',
          },
        ],
        { expectedRevision: 2, idempotencyKey: 'q1-3' },
        context,
      );
      context = await port.resolveAuthorization({
        principalId: 'administrator',
        activeWorkspaceId: 'workspace-1',
      });
      await port.createItem(
        { id: 'Q2', labels: { en: { language: 'en', value: 'Clean item' } } },
        { idempotencyKey: 'create-q2' },
        context,
      );

      const ownerOrReader = {
        version: 1 as const,
        // Clauses are ANDed. Both principals must be atoms in this one OR-clause.
        clauses: [
          [
            { kind: 'principal' as const, principalId: 'administrator' },
            { kind: 'principal' as const, principalId: 'reader' },
          ],
        ],
      };
      const beforeQ2 = await visibilityState(db, 'Q2');
      const q2 = await commit(
        {
          type: 'set-entity-visibility',
          entityId: 'Q2',
          expectedRevision: 1,
          visibility: ownerOrReader,
        },
        'visibility-policy-set-q2-1',
      );
      expect(q2.receipt).toMatchObject({
        command: 'set-entity-visibility',
        authorizationRevision: beforeQ2.authorizationRevision + 1,
        searchGeneration: beforeQ2.searchGeneration + 1,
        replayed: false,
      });
      expect(await visibilityState(db, 'Q2')).toMatchObject({
        entityRevision: 2,
        sourceRevision: 2,
        authorizationRevision: beforeQ2.authorizationRevision + 1,
        searchGeneration: beforeQ2.searchGeneration + 1,
        auditCount: beforeQ2.auditCount + 1,
        visibilityJson: JSON.stringify(ownerOrReader),
      });
      const afterQ2 = await visibilityState(db, 'Q2');
      const replayContext = await port.resolveAuthorization({
        principalId: 'administrator',
        activeWorkspaceId: 'workspace-1',
      });
      const replayParticipant = await prepareAuthorizationAdministrationV1(
        db,
        options,
        authority,
        q2.input,
        replayContext,
      );
      await expect(
        commitAuthorizationAdministrationV1(
          replayParticipant,
          await owner.seal(replayParticipant, {}),
        ),
      ).resolves.toMatchObject({ replayed: true });
      expect(await visibilityState(db, 'Q2')).toEqual(afterQ2);

      const beforeQ1 = await visibilityState(db, 'Q1');
      const q1 = await commit(
        {
          type: 'set-entity-visibility',
          entityId: 'Q1',
          expectedRevision: 3,
          visibility: ownerOrReader,
        },
        'visibility-policy-set-q1-3',
      );
      expect(q1.receipt).toMatchObject({
        authorizationRevision: beforeQ1.authorizationRevision + 1,
        searchGeneration: beforeQ1.searchGeneration + 1,
      });
      await expect(
        db
          .prepare(
            `SELECT e.revision, p.source_revision, p.visibility_json,
                    (SELECT COUNT(*) FROM taproot_statement_authorization
                     WHERE entity_id='Q1' AND source_revision=4) AS statements
             FROM taproot_entities e
             JOIN taproot_entity_authorization p ON p.entity_id=e.entity_id
             WHERE e.entity_id='Q1'`,
          )
          .all<Record<string, unknown>>(),
      ).resolves.toMatchObject({
        results: [
          {
            revision: 4,
            source_revision: 4,
            visibility_json: JSON.stringify(ownerOrReader),
            statements: 1,
          },
        ],
      });

      const ownerAndReader = {
        version: 1 as const,
        clauses: [
          [{ kind: 'principal' as const, principalId: 'administrator' }],
          [{ kind: 'principal' as const, principalId: 'reader' }],
        ],
      };
      const beforeInvalid = await visibilityState(db, 'Q1');
      await expect(
        commit(
          {
            type: 'set-entity-visibility',
            entityId: 'Q1',
            expectedRevision: 4,
            visibility: ownerAndReader,
          },
          'visibility-policy-unsatisfiable-cnf',
        ),
      ).rejects.toBeInstanceOf(InvalidEntityError);
      expect(await visibilityState(db, 'Q1')).toEqual(beforeInvalid);

      context = await port.resolveAuthorization({
        principalId: 'administrator',
        activeWorkspaceId: 'workspace-1',
      });
      const stale = await prepareAuthorizationAdministrationV1(
        db,
        options,
        authority,
        {
          installationId,
          expectedAuthorizationRevision: context.authorizationRevision,
          idempotencyKey: 'visibility-policy-stale',
          command: {
            type: 'set-entity-visibility',
            entityId: 'Q1',
            expectedRevision: 3,
            visibility: ownerOrReader,
          },
        },
        context,
      );
      await expect(
        commitAuthorizationAdministrationV1(stale, await owner.seal(stale, {})),
      ).rejects.toBeInstanceOf(RevisionConflictError);
      context = await port.resolveAuthorization({
        principalId: 'administrator',
        activeWorkspaceId: 'workspace-1',
      });
      const missing = await prepareAuthorizationAdministrationV1(
        db,
        options,
        authority,
        {
          installationId,
          expectedAuthorizationRevision: context.authorizationRevision,
          idempotencyKey: 'visibility-policy-missing',
          command: {
            type: 'set-entity-visibility',
            entityId: 'Q999',
            expectedRevision: 1,
            visibility: ownerOrReader,
          },
        },
        context,
      );
      await expect(
        commitAuthorizationAdministrationV1(
          missing,
          await owner.seal(missing, {}),
        ),
      ).rejects.toBeInstanceOf(EntityNotFoundError);
      await expect(
        prepareAuthorizationAdministrationV1(
          db,
          options,
          authority,
          {
            installationId,
            expectedAuthorizationRevision: context.authorizationRevision,
            idempotencyKey: 'visibility-policy-invalid',
            command: {
              type: 'set-entity-visibility',
              entityId: 'Q1',
              expectedRevision: 4,
              visibility: { version: 1, clauses: [[]] },
            },
          },
          context,
        ),
      ).rejects.toBeInstanceOf(InvalidAuthorizationError);
      const readerContext = await port.resolveAuthorization({
        principalId: 'reader',
        activeWorkspaceId: 'workspace-1',
      });
      await expect(
        prepareAuthorizationAdministrationV1(
          db,
          options,
          authority,
          {
            installationId,
            expectedAuthorizationRevision: readerContext.authorizationRevision,
            idempotencyKey: 'visibility-policy-unauthorized',
            command: {
              type: 'set-entity-visibility',
              entityId: 'Q1',
              expectedRevision: 4,
              visibility: ownerOrReader,
            },
          },
          readerContext,
        ),
      ).rejects.toBeInstanceOf(AuthorizationDeniedError);

      const outsiderContext = await port.resolveAuthorization({
        principalId: 'outsider',
      });
      const cursorKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      const cursorCodec = createAuthorizationCursorCodec(cursorKey);
      for (const visibleContext of [context, readerContext]) {
        const reader = createAuthorizedTaproot(db, options, visibleContext, {
          cursorCodec,
        });
        await expect(reader.getEntity('Q1')).resolves.toMatchObject({
          entity: { id: 'Q1', lastrevid: 4 },
        });
        await expect(reader.getEntity('Q2')).resolves.toMatchObject({
          entity: { id: 'Q2', lastrevid: 2 },
        });
      }
      const outsider = createAuthorizedTaproot(db, options, outsiderContext, {
        cursorCodec,
      });
      await expect(outsider.getEntity('Q1')).rejects.toBeInstanceOf(
        AuthorizationDeniedError,
      );
      await expect(outsider.getEntity('Q2')).rejects.toBeInstanceOf(
        AuthorizationDeniedError,
      );

      await db.close();
      db = new NodeSqliteDatabase(databasePath);
      authority = createTaprootHostWriteCapability(db, options, key);
      port = await createTaprootWorkshopPortV1(db, options, authority, {
        installationId,
      });
      for (const principal of [
        { principalId: 'administrator', activeWorkspaceId: 'workspace-1' },
        { principalId: 'reader', activeWorkspaceId: 'workspace-1' },
      ]) {
        const restartedContext = await port.resolveAuthorization(principal);
        const restarted = createAuthorizedTaproot(
          db,
          options,
          restartedContext,
          { cursorCodec },
        );
        await expect(restarted.getEntity('Q1')).resolves.toBeTruthy();
        await expect(restarted.getEntity('Q2')).resolves.toBeTruthy();
      }
      const restartedOutsider = createAuthorizedTaproot(
        db,
        options,
        await port.resolveAuthorization({ principalId: 'outsider' }),
        { cursorCodec },
      );
      await expect(restartedOutsider.getEntity('Q1')).rejects.toBeInstanceOf(
        AuthorizationDeniedError,
      );
    } finally {
      await db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves the same CAS and replay contract across a real Workerd D1 connection restart', async () => {
    const miniflare = new Miniflare({
      modules: true,
      script: 'export default {}',
      d1Databases: { DB: 'authorization-administration-d1' },
    });
    const options = { baseIri: 'https://authorization-admin-d1.example' };
    try {
      const first = (await miniflare.getD1Database(
        'DB',
      )) as unknown as D1DatabaseLike;
      await initializeTaproot(first, options);
      const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const authority = createTaprootHostWriteCapability(first, options, key);
      const bootstrapOwner = await registerAuthorizationBootstrapOwnerV1(
        first,
        options,
        authority,
        {
          installationId: 'installation-1',
          ownerRegistrationId: 'bootstrap',
          adapter: {
            kind: 'taproot-authorization-bootstrap-owner-adapter-v1',
            prepare: () => Promise.resolve({ statements: [], receipt: {} }),
          },
        },
      );
      const bootstrap = await prepareAuthorizationBootstrapV1(
        first,
        options,
        authority,
        {
          installationId: 'installation-1',
          baseIri: options.baseIri,
          principalId: 'administrator',
          workspaceId: 'workspace-1',
          grants: ['search:admin'],
          idempotencyKey: 'bootstrap',
        },
      );
      await commitAuthorizationBootstrapV1(
        bootstrap,
        await bootstrapOwner.seal(bootstrap, {}),
      );
      const owner = await registerAuthorizationAdministrationOwnerV1(
        first,
        options,
        authority,
        {
          installationId: 'installation-1',
          ownerRegistrationId: 'owner-v1',
          adapter: {
            kind: 'taproot-authorization-administration-owner-adapter-v1',
            prepare: () => Promise.resolve({ statements: [], receipt: {} }),
          },
        },
      );
      const input = {
        installationId: 'installation-1',
        expectedAuthorizationRevision: 1,
        idempotencyKey: 'workspace-2',
        command: {
          type: 'put-workspace' as const,
          workspaceId: 'workspace-2',
        },
      };
      const participant = await prepareAuthorizationAdministrationV1(
        first,
        options,
        authority,
        input,
        adminContext(1),
      );
      await commitAuthorizationAdministrationV1(
        participant,
        await owner.seal(participant, {}),
      );

      const restarted = (await miniflare.getD1Database(
        'DB',
      )) as unknown as D1DatabaseLike;
      const restartedAuthority = createTaprootHostWriteCapability(
        restarted,
        options,
        key,
      );
      const restartedOwner = await registerAuthorizationAdministrationOwnerV1(
        restarted,
        options,
        restartedAuthority,
        {
          installationId: 'installation-1',
          ownerRegistrationId: 'owner-v1',
          adapter: {
            kind: 'taproot-authorization-administration-owner-adapter-v1',
            prepare: () => {
              throw new Error('replay must not prepare owner state');
            },
          },
        },
      );
      const replay = await prepareAuthorizationAdministrationV1(
        restarted,
        options,
        restartedAuthority,
        input,
        adminContext(1),
      );
      await expect(
        commitAuthorizationAdministrationV1(
          replay,
          await restartedOwner.seal(replay, {}),
        ),
      ).resolves.toMatchObject({ replayed: true, authorizationRevision: 2 });
    } finally {
      await miniflare.dispose();
    }
  }, 60_000);

  it('atomically coordinates owner mappings, revision CAS, revocation, and durable replay', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    const options = { baseIri: 'https://authorization-admin.example' };
    try {
      await initializeTaproot(db, options);
      await db
        .prepare(
          `CREATE TABLE workshop_owner_mappings(
             mapping_id TEXT PRIMARY KEY, value TEXT NOT NULL
           ) STRICT`,
        )
        .run();
      const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const authority = createTaprootHostWriteCapability(db, options, key);
      const bootstrapOwner = await registerAuthorizationBootstrapOwnerV1(
        db,
        options,
        authority,
        {
          installationId: 'installation-1',
          ownerRegistrationId: 'workshop-bootstrap',
          adapter: {
            kind: 'taproot-authorization-bootstrap-owner-adapter-v1',
            prepare: () => Promise.resolve({ statements: [], receipt: {} }),
          },
        },
      );
      const bootstrap = await prepareAuthorizationBootstrapV1(
        db,
        options,
        authority,
        {
          installationId: 'installation-1',
          baseIri: options.baseIri,
          principalId: 'administrator',
          workspaceId: 'workspace-1',
          grants: ['search:admin'],
          idempotencyKey: 'bootstrap',
        },
      );
      await commitAuthorizationBootstrapV1(
        bootstrap,
        await bootstrapOwner.seal(bootstrap, {}),
      );
      let ownerPrepares = 0;
      const owner = await registerAuthorizationAdministrationOwnerV1(
        db,
        options,
        authority,
        {
          installationId: 'installation-1',
          ownerRegistrationId: 'workshop-credentials-v1',
          adapter: {
            kind: 'taproot-authorization-administration-owner-adapter-v1',
            prepare: (token) => {
              ownerPrepares += 1;
              return Promise.resolve({
                statements: [
                  db
                    .prepare(
                      `INSERT INTO workshop_owner_mappings(mapping_id, value)
                       VALUES (?, ?)`,
                    )
                    .bind(
                      (token as { id: string }).id,
                      'credential-selector-only',
                    ),
                ],
                receipt: { mapped: (token as { id: string }).id },
              });
            },
          },
        },
      );
      const context = adminContext(1);
      const input = {
        installationId: 'installation-1',
        expectedAuthorizationRevision: 1,
        idempotencyKey: 'principal-2',
        command: { type: 'put-principal' as const, principalId: 'principal-2' },
      };
      const participant = await prepareAuthorizationAdministrationV1(
        db,
        options,
        authority,
        input,
        context,
      );
      const receipt = await commitAuthorizationAdministrationV1(
        participant,
        await owner.seal(participant, { id: 'mapping-1' }),
      );
      expect(receipt).toMatchObject({
        format: 'taproot-authorization-administration-receipt-v1',
        authorizationRevision: 2,
        searchGeneration: 2,
        replayed: false,
      });
      expect(
        await db
          .prepare(`SELECT value FROM workshop_owner_mappings`)
          .all<{ value: string }>(),
      ).toMatchObject({
        results: [{ value: 'credential-selector-only' }],
      });

      const replay = await prepareAuthorizationAdministrationV1(
        db,
        options,
        authority,
        input,
        context,
      );
      await expect(
        commitAuthorizationAdministrationV1(
          replay,
          await owner.seal(replay, { id: 'unused' }),
        ),
      ).resolves.toMatchObject({ replayed: true, authorizationRevision: 2 });
      expect(ownerPrepares).toBe(1);

      await expect(
        prepareAuthorizationAdministrationV1(
          db,
          options,
          authority,
          {
            ...input,
            idempotencyKey: 'lost-race',
            command: {
              type: 'put-workspace',
              workspaceId: 'workspace-2',
            },
          },
          context,
        ),
      ).rejects.toThrow(/stale/u);

      const revoke = await prepareAuthorizationAdministrationV1(
        db,
        options,
        authority,
        {
          installationId: 'installation-1',
          expectedAuthorizationRevision: 2,
          idempotencyKey: 'revoke-admin',
          command: {
            type: 'put-grant',
            principalId: 'administrator',
            workspaceId: 'workspace-1',
            capability: 'search:admin',
            granted: false,
          },
        },
        adminContext(2),
      );
      await commitAuthorizationAdministrationV1(
        revoke,
        await owner.seal(revoke, { id: 'mapping-2' }),
      );
      await expect(
        prepareAuthorizationAdministrationV1(
          db,
          options,
          authority,
          {
            installationId: 'installation-1',
            expectedAuthorizationRevision: 3,
            idempotencyKey: 'after-revocation',
            command: {
              type: 'put-workspace',
              workspaceId: 'workspace-3',
            },
          },
          adminContext(3),
        ),
      ).rejects.toThrow(/live search administrator/u);
    } finally {
      await db.close();
    }
  });
});

async function visibilityState(
  db: D1DatabaseLike,
  entityId: string,
): Promise<{
  entityRevision: number;
  sourceRevision: number;
  authorizationRevision: number;
  searchGeneration: number;
  auditCount: number;
  visibilityJson: string;
}> {
  const result = await db
    .prepare(
      `SELECT e.revision AS entityRevision,
              p.source_revision AS sourceRevision,
              p.visibility_json AS visibilityJson,
              s.authorization_revision AS authorizationRevision,
              s.search_generation AS searchGeneration,
              (SELECT COUNT(*) FROM taproot_audit_events
               WHERE entity_id=e.entity_id) AS auditCount
       FROM taproot_entities e
       JOIN taproot_entity_authorization p ON p.entity_id=e.entity_id
       JOIN taproot_installation_authorization s ON s.singleton=1
       WHERE e.entity_id=?`,
    )
    .bind(entityId)
    .all<Record<string, unknown>>();
  const row = result.results[0];
  if (!row) throw new Error(`Missing visibility state for ${entityId}`);
  return {
    entityRevision: Number(row.entityRevision),
    sourceRevision: Number(row.sourceRevision),
    authorizationRevision: Number(row.authorizationRevision),
    searchGeneration: Number(row.searchGeneration),
    auditCount: Number(row.auditCount),
    visibilityJson: String(row.visibilityJson),
  };
}

function adminContext(revision: number): AuthorizationContext {
  return {
    installationId: 'installation-1',
    principalId: 'administrator',
    activeWorkspaceId: 'workspace-1',
    workspaceIds: ['workspace-1'],
    capabilities: ['search:admin'],
    authorizationRevision: revision,
  };
}
