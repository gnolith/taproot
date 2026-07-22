import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_POLICY_CAPABILITY,
  KNOWLEDGE_WRITE_CAPABILITY,
  SEARCH_ADMIN_CAPABILITY,
  TaprootContentRepositoryV1,
  bootstrapTaprootAuthorization,
  createAuthorizedSearchServiceV1,
  createItem,
  createInstallationAuthorizationGuard,
  createSearchMaterializationAdminGuardV1,
  createTaprootHostWriteCapability,
  createTaprootInstallationSnapshotV1,
  initializeTaproot,
  restoreTaprootInstallationSnapshotV1,
  type AuthorizationContext,
  type TaprootHostWriteCapability,
} from '../src/index.js';

const options = { baseIri: 'https://snapshot.example' };
const installationId = 'installation-snapshot';
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('installation snapshots', () => {
  it('round-trips canonical RDF, content, authorization, and compatible search state without credentials', async () => {
    const source = await database('source');
    const target = await database('target');
    try {
      await bootstrapTaprootAuthorization(
        source.db,
        options,
        source.capability,
        installationId,
      );
      const guard = await createInstallationAuthorizationGuard(
        source.db,
        options,
        source.capability,
      );
      await createItem(source.db, options, guard, writer(1), {
        id: 'Q1',
        labels: { en: { language: 'en', value: 'Snapshot Needle' } },
        authorization: {
          installationId,
          workspaceId: null,
          ownerPrincipalId: 'principal-1',
          visibility: { version: 1, clauses: [] },
          statementRestrictions: {},
          expectedAuthorizationRevision: 1,
        },
      });
      const content = new TaprootContentRepositoryV1(source.db, {
        installationId,
        createId: () => crypto.randomUUID(),
      });
      await content.createResource(
        {
          id: 'resource-1',
          itemId: 'Q1',
          title: 'Snapshot Resource',
          payload: { kind: 'inline-text', text: 'Snapshot Needle body' },
          mediaType: 'text/plain',
          integrity: {
            algorithm: 'sha256',
            digest: await digest('Snapshot Needle body'),
            byteLength: new TextEncoder().encode('Snapshot Needle body')
              .byteLength,
          },
        },
        {
          context: writer(2),
          attribution: { id: 'principal-1', kind: 'human' },
          workspaceId: null,
          ownerPrincipalId: 'principal-1',
          visibility: { version: 1, clauses: [] },
          expectedAuthorizationRevision: 2,
        },
      );
      const materialization = await createSearchMaterializationAdminGuardV1(
        source.db,
        options,
        source.capability,
      );
      await materialization.initialize(admin(3));
      await materialization.run(admin(3), {
        maxJobs: 20,
        maxRebuildRoots: 20,
        maxChunkBytes: 128,
        leaseMilliseconds: 30_000,
      });

      const snapshot = await createTaprootInstallationSnapshotV1(
        source.db,
        installationId,
        admin(3),
      );
      expect(snapshot.credentialsIncluded).toBe(false);
      for (const rows of Object.values(snapshot.tables))
        for (const row of rows)
          expect(Object.keys(row).join(' ')).not.toMatch(
            /api[_-]?key|secret|credential|authorization_header/iu,
          );
      await restoreTaprootInstallationSnapshotV1(target.db, snapshot, admin(3));

      const restoredContent = new TaprootContentRepositoryV1(target.db, {
        installationId,
      });
      await expect(
        restoredContent.getResource('resource-1', reader(3)),
      ).resolves.toMatchObject({ id: 'resource-1', revision: 1 });
      const search = createAuthorizedSearchServiceV1(target.db, {
        installationId,
        content: restoredContent,
      });
      expect(
        (await search.search({ text: 'Snapshot Needle' }, reader(3))).results,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'item', sourceId: 'Q1' }),
          expect.objectContaining({ kind: 'resource', sourceId: 'resource-1' }),
        ]),
      );
      const counts = await target.db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM rdf_quads) AS quads,
             (SELECT COUNT(*) FROM taproot_rdf_ownership WHERE entity_id='Q1') AS ownership`,
        )
        .all<{ quads: number; ownership: number }>();
      expect(Number(counts.results[0]?.quads)).toBeGreaterThan(0);
      expect(counts.results[0]?.ownership).toBe(counts.results[0]?.quads);
    } finally {
      await source.db.close();
      await target.db.close();
    }
  }, 60_000);
});

function writer(revision: number): AuthorizationContext {
  return {
    installationId,
    principalId: 'principal-1',
    activeWorkspaceId: null,
    workspaceIds: [],
    capabilities: [KNOWLEDGE_WRITE_CAPABILITY, KNOWLEDGE_POLICY_CAPABILITY],
    authorizationRevision: revision,
  };
}

function reader(revision: number): AuthorizationContext {
  return { ...writer(revision), capabilities: [] };
}

function admin(revision: number): AuthorizationContext {
  return { ...writer(revision), capabilities: [SEARCH_ADMIN_CAPABILITY] };
}

async function database(name: string) {
  const directory = mkdtempSync(join(tmpdir(), `taproot-snapshot-${name}-`));
  directories.push(directory);
  const db = new NodeSqliteDatabase(join(directory, 'taproot.sqlite'));
  await initializeTaproot(db, options);
  const key = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const capability: TaprootHostWriteCapability =
    createTaprootHostWriteCapability(db, options, key);
  return { db, capability };
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
