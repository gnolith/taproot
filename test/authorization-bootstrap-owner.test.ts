import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { describe, expect, it } from 'vitest';
import {
  commitAuthorizationBootstrapV1,
  createTaprootHostWriteCapability,
  initializeTaproot,
  prepareAuthorizationBootstrapV1,
  registerAuthorizationBootstrapOwnerV1,
  type AuthorizationBootstrapParticipantV1,
} from '../src/index.js';

describe('sealed authorization bootstrap owner protocol', () => {
  it('commits once, returns a durable replay receipt, and rejects forged participants', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    const options = { baseIri: 'https://bootstrap.example' };
    try {
      await initializeTaproot(db, options);
      const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const authority = createTaprootHostWriteCapability(db, options, key);
      let preparedOwnerPlans = 0;
      const owner = await registerAuthorizationBootstrapOwnerV1(
        db,
        options,
        authority,
        {
          installationId: 'installation-1',
          ownerRegistrationId: 'seedbed-owner-1',
          adapter: {
            kind: 'taproot-authorization-bootstrap-owner-adapter-v1',
            prepare: () => {
              preparedOwnerPlans += 1;
              return Promise.resolve({
                statements: [],
                receipt: { owner: 'seedbed-owner-1', revision: 1 },
              });
            },
          },
        },
      );
      const input = {
        installationId: 'installation-1',
        baseIri: options.baseIri,
        principalId: 'principal-1',
        workspaceId: 'workspace-1',
        grants: ['knowledge:read', 'knowledge:write'],
        idempotencyKey: 'bootstrap-1',
      };
      const participant = await prepareAuthorizationBootstrapV1(
        db,
        options,
        authority,
        input,
      );
      const ownerParticipant = await owner.seal(participant, {
        opaque: 'owner-token',
      });
      const first = await commitAuthorizationBootstrapV1(
        participant,
        ownerParticipant,
      );
      expect(first).toMatchObject({
        format: 'taproot-authorization-bootstrap-receipt-v1',
        installationId: input.installationId,
        principalId: input.principalId,
        workspaceId: input.workspaceId,
        authorizationRevision: 1,
        replayed: false,
      });
      expect(preparedOwnerPlans).toBe(1);
      await expect(
        commitAuthorizationBootstrapV1(participant, ownerParticipant),
      ).rejects.toThrow(/participants are invalid/u);

      const replayParticipant = await prepareAuthorizationBootstrapV1(
        db,
        options,
        authority,
        input,
      );
      const replayOwner = await owner.seal(replayParticipant, {});
      await expect(
        commitAuthorizationBootstrapV1(replayParticipant, replayOwner),
      ).resolves.toMatchObject({
        bootstrapId: first.bootstrapId,
        replayed: true,
      });
      expect(preparedOwnerPlans).toBe(1);

      expect(() =>
        owner.seal(
          Object.freeze({
            kind: 'taproot-authorization-bootstrap-participant-v1',
            installationId: input.installationId,
            connectionId: replayParticipant.connectionId,
          }) as AuthorizationBootstrapParticipantV1,
          {},
        ),
      ).toThrow(/binding mismatch/u);
      await expect(
        prepareAuthorizationBootstrapV1(db, options, authority, {
          ...input,
          principalId: 'principal-2',
        }),
      ).rejects.toThrow(/conflicting/u);
    } finally {
      await db.close();
    }
  });

  it('rejects malformed input and unbounded owner plans', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    const options = { baseIri: 'https://bootstrap-invalid.example' };
    try {
      await initializeTaproot(db, options);
      const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const authority = createTaprootHostWriteCapability(db, options, key);
      const valid = {
        installationId: 'installation-1',
        baseIri: options.baseIri,
        principalId: 'principal-1',
        workspaceId: 'workspace-1',
        grants: ['knowledge:read'],
        idempotencyKey: 'bootstrap-1',
      };
      for (const candidate of [
        { ...valid, installationId: ' installation-1' },
        { ...valid, baseIri: 'ftp://bootstrap-invalid.example' },
        { ...valid, baseIri: 'https://user@bootstrap-invalid.example' },
        { ...valid, baseIri: 'https://bootstrap-invalid.example?query=1' },
        { ...valid, baseIri: 'https://bootstrap-invalid.example#fragment' },
        { ...valid, baseIri: 'https://different.example' },
        { ...valid, principalId: 'principal-\u0000' },
        { ...valid, grants: [] },
        {
          ...valid,
          grants: Array.from({ length: 129 }, (_, i) => `grant-${i}`),
        },
        { ...valid, grants: ['knowledge:read', 'knowledge:read'] },
        { ...valid, grants: [null as never] },
      ])
        await expect(
          prepareAuthorizationBootstrapV1(db, options, authority, candidate),
        ).rejects.toThrow();
      await expect(
        prepareAuthorizationBootstrapV1(db, options, authority, {
          ...valid,
          grants: ['knowledge:write', 'knowledge:read'],
        }),
      ).rejects.toThrow(/sorted and unique/u);
      expect(() =>
        registerAuthorizationBootstrapOwnerV1(db, options, authority, {
          installationId: 'installation-1',
          ownerRegistrationId: 'invalid-owner',
          adapter: {} as never,
        }),
      ).toThrow(/adapter is invalid/u);
      expect(() =>
        registerAuthorizationBootstrapOwnerV1(db, options, authority, {
          installationId: '',
          ownerRegistrationId: 'invalid-owner',
          adapter: {
            kind: 'taproot-authorization-bootstrap-owner-adapter-v1',
            prepare: () => Promise.resolve({ statements: [], receipt: null }),
          },
        }),
      ).toThrow(/installationId is invalid/u);
      const owner = await registerAuthorizationBootstrapOwnerV1(
        db,
        options,
        authority,
        {
          installationId: 'installation-1',
          ownerRegistrationId: 'invalid-owner',
          adapter: {
            kind: 'taproot-authorization-bootstrap-owner-adapter-v1',
            prepare: () =>
              Promise.resolve({
                statements: [null],
                receipt: null,
              }),
          },
        },
      );
      const participant = await prepareAuthorizationBootstrapV1(
        db,
        options,
        authority,
        valid,
      );
      await expect(
        commitAuthorizationBootstrapV1(
          participant,
          await owner.seal(participant, {}),
        ),
      ).rejects.toThrow(/owner plan is invalid/u);
    } finally {
      await db.close();
    }
  });
});
