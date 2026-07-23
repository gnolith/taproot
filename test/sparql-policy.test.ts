import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { describe, expect, it } from 'vitest';
import {
  bootstrapTaprootAuthorization,
  createTaprootHostWriteCapability,
  initializeTaproot,
  type AuthorizationContext,
} from '../src/index.js';
import {
  hydrateScopedSparqlReferencesV1,
  prepareScopedSparqlPolicyV1,
} from '../src/sparql-policy.js';

describe('scoped SPARQL policy', () => {
  it('binds an empty authorized dataset to the live connection and fence', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    const options = { baseIri: 'https://sparql-policy.example' };
    const installationId = 'installation-1';
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
      const now = '2026-07-23T00:00:00.000Z';
      await db.batch(
        (
          [
            ['taproot_resources', 'resource-1', { id: 'resource-1' }],
            ['taproot_annotations', 'annotation-1', { id: 'annotation-1' }],
          ] as const
        ).map(([table, id, record]) =>
          db
            .prepare(
              `INSERT INTO ${table}(
                 record_id, installation_id, revision, record_json,
                 policy_revision, visibility_json, created_at, modified_at
               ) VALUES (?, ?, 1, ?, 1, ?, ?, ?)`,
            )
            .bind(
              id,
              installationId,
              JSON.stringify(record),
              JSON.stringify({ version: 1, clauses: [] }),
              now,
              now,
            ),
        ),
      );
      await db
        .prepare(
          `INSERT INTO taproot_resources(
             record_id, installation_id, revision, record_json,
             policy_revision, visibility_json, created_at, modified_at
           ) VALUES (?, ?, 1, ?, 1, ?, ?, ?)`,
        )
        .bind(
          'resource-private',
          installationId,
          JSON.stringify({ id: 'resource-private' }),
          JSON.stringify({
            version: 1,
            clauses: [
              [{ kind: 'workspace', workspaceId: 'workspace-private' }],
            ],
          }),
          now,
          now,
        )
        .run();
      const context: AuthorizationContext = {
        installationId,
        principalId: 'principal-1',
        activeWorkspaceId: null,
        workspaceIds: [],
        capabilities: [],
        authorizationRevision: 1,
      };
      const policy = await prepareScopedSparqlPolicyV1(
        db,
        { installationId, baseIri: options.baseIri },
        context,
      );
      expect(policy).toMatchObject({
        kind: 'taproot-scoped-sparql-policy-v1',
        filter: {
          format: 'taproot-sparql-graph-filter-v1',
          allowedSubjectIris: [
            `${options.baseIri}/annotation/annotation-1`,
            `${options.baseIri}/resource/resource-1`,
          ],
        },
      });
      await expect(
        hydrateScopedSparqlReferencesV1(policy, [], context),
      ).resolves.toEqual([]);
      await expect(
        hydrateScopedSparqlReferencesV1(
          policy,
          [
            {
              kind: 'resource',
              sourceId: 'resource-1',
              sourceRevision: '1',
            },
            {
              kind: 'annotation',
              sourceId: 'annotation-1',
              sourceRevision: '1',
            },
          ],
          context,
        ),
      ).resolves.toEqual([{ id: 'resource-1' }, { id: 'annotation-1' }]);
      await expect(
        hydrateScopedSparqlReferencesV1({ ...policy }, [], context),
      ).rejects.toThrow(/policy is invalid/u);
      await expect(
        prepareScopedSparqlPolicyV1(
          db,
          { installationId: 'other-installation', baseIri: options.baseIri },
          context,
        ),
      ).rejects.toThrow(/installation mismatch/u);
      await expect(
        prepareScopedSparqlPolicyV1(
          db,
          { installationId, baseIri: 'https://different.example' },
          context,
        ),
      ).rejects.toThrow(/database identity mismatch/u);
      await expect(
        prepareScopedSparqlPolicyV1(
          db,
          { installationId, baseIri: options.baseIri },
          { ...context, authorizationRevision: 2 },
        ),
      ).rejects.toThrow(/fence is stale/u);
      await expect(
        hydrateScopedSparqlReferencesV1(policy, [], {
          ...context,
          authorizationRevision: 2,
        }),
      ).rejects.toThrow(/fence is stale/u);
      for (const reference of [
        { kind: 'item', sourceId: 'missing-item', sourceRevision: '1' },
        { kind: 'resource', sourceId: 'missing-resource', sourceRevision: '1' },
        {
          kind: 'annotation',
          sourceId: 'missing-annotation',
          sourceRevision: '1',
        },
        { kind: 'invalid', sourceId: 'missing', sourceRevision: '1' },
        { kind: 'item', sourceId: '', sourceRevision: '1' },
        { kind: 'item', sourceId: 'missing', sourceRevision: '' },
        { kind: 'resource', sourceId: 'resource-1', sourceRevision: '2' },
        {
          kind: 'item',
          sourceId: 'x'.repeat(257),
          sourceRevision: '1',
        },
      ])
        await expect(
          hydrateScopedSparqlReferencesV1(
            policy,
            [reference as never],
            context,
          ),
        ).rejects.toThrow();
      await expect(
        hydrateScopedSparqlReferencesV1(
          policy,
          Array.from({ length: 1001 }, () => ({
            kind: 'item' as const,
            sourceId: 'missing',
            sourceRevision: '1',
          })),
          context,
        ),
      ).rejects.toThrow(/batch is too large/u);
    } finally {
      await db.close();
    }
  });
});
