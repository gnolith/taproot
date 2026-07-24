import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import type { D1DatabaseLike } from '@gnolith/diamond';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import {
  commitAuthorizationAdministrationV1,
  commitAuthorizationBootstrapV1,
  createTaprootWorkshopPortV1,
  createTaprootHostWriteCapability,
  EntityNotFoundError,
  initializeTaproot,
  KNOWLEDGE_POLICY_CAPABILITY,
  KNOWLEDGE_WRITE_CAPABILITY,
  prepareAuthorizationAdministrationV1,
  prepareAuthorizationBootstrapV1,
  registerAuthorizationAdministrationOwnerV1,
  registerAuthorizationBootstrapOwnerV1,
  RevisionConflictError,
  type AuthorizationContext,
} from '../src/index.js';

describe('sealed authorization administration owner protocol', () => {
  it('updates the visibility policy of exact Q1 revision 3 and fences stale or missing targets', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    const options = { baseIri: 'https://visibility-admin.example' };
    const installationId = 'installation-1';
    try {
      await initializeTaproot(db, options);
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
      const port = await createTaprootWorkshopPortV1(db, options, authority, {
        installationId,
      });
      let context = await port.resolveAuthorization({
        principalId: 'administrator',
        activeWorkspaceId: 'workspace-1',
      });
      await port.createItem(
        { id: 'Q1' },
        { idempotencyKey: 'create-q1' },
        context,
      );
      for (const [expectedRevision, value] of [
        [1, 'one'],
        [2, 'two'],
      ] as const) {
        context = await port.resolveAuthorization({
          principalId: 'administrator',
          activeWorkspaceId: 'workspace-1',
        });
        await port.mutateEntity(
          'Q1',
          [
            {
              command: { type: 'set-label', language: 'en', value },
              authoredText: `Set Q1 label to ${value}.`,
            },
          ],
          {
            expectedRevision,
            idempotencyKey: `q1-${expectedRevision + 1}`,
          },
          context,
        );
      }
      context = await port.resolveAuthorization({
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
      const update = {
        installationId,
        expectedAuthorizationRevision: context.authorizationRevision,
        idempotencyKey: 'visibility-policy-set-q1-3',
        command: {
          type: 'set-entity-visibility' as const,
          entityId: 'Q1',
          expectedRevision: 3,
          visibility: { version: 1 as const, clauses: [] },
        },
      };
      const participant = await prepareAuthorizationAdministrationV1(
        db,
        options,
        authority,
        update,
        context,
      );
      await expect(
        commitAuthorizationAdministrationV1(
          participant,
          await owner.seal(participant, {}),
        ),
      ).resolves.toMatchObject({
        command: 'set-entity-visibility',
        authorizationRevision: context.authorizationRevision + 1,
      });
      await expect(
        db
          .prepare(
            `SELECT e.revision, p.source_revision, p.visibility_json
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
            visibility_json: '{"version":1,"clauses":[]}',
          },
        ],
      });

      const nextContext = await port.resolveAuthorization({
        principalId: 'administrator',
        activeWorkspaceId: 'workspace-1',
      });
      const stale = await prepareAuthorizationAdministrationV1(
        db,
        options,
        authority,
        {
          ...update,
          expectedAuthorizationRevision: nextContext.authorizationRevision,
          idempotencyKey: 'visibility-policy-stale',
        },
        nextContext,
      );
      await expect(
        commitAuthorizationAdministrationV1(stale, await owner.seal(stale, {})),
      ).rejects.toBeInstanceOf(RevisionConflictError);
      const missing = await prepareAuthorizationAdministrationV1(
        db,
        options,
        authority,
        {
          ...update,
          expectedAuthorizationRevision: nextContext.authorizationRevision,
          idempotencyKey: 'visibility-policy-missing',
          command: {
            ...update.command,
            entityId: 'Q999',
            expectedRevision: 1,
          },
        },
        nextContext,
      );
      await expect(
        commitAuthorizationAdministrationV1(
          missing,
          await owner.seal(missing, {}),
        ),
      ).rejects.toBeInstanceOf(EntityNotFoundError);
    } finally {
      await db.close();
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
