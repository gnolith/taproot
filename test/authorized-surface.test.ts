import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { D1DatabaseLike, SqliteDatabaseLike } from '@gnolith/diamond';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import * as publicApi from '../src/index.js';
import {
  AuthorizationDeniedError,
  InvalidAuthorizationError,
  InvalidCursorError,
  SEARCH_ADMIN_CAPABILITY,
  KNOWLEDGE_WRITE_CAPABILITY,
  applyTaprootAuthorizationBackfill,
  bootstrapLegacyTaprootAuthorization,
  bootstrapTaprootAuthorization,
  createAuthorizationCursorCodec,
  createAuthorizedTaproot,
  createItem,
  createTaprootHostWriteCapability,
  createInstallationAuthorizationGuard,
  initializeTaproot,
  planTaprootAuthorizationBackfill,
  type AuthorizationContext,
  type TaprootHostWriteCapability,
  type VisibilityScopeV1,
} from '../src/index.js';
import { TaprootRepository } from '../src/repository.js';

const options = { baseIri: 'https://authorized-surface.example' };
const installationId = 'installation-1';
const temporaryDirectories: string[] = [];
const publicScope: VisibilityScopeV1 = { version: 1, clauses: [] };
const workspace = (workspaceId: string): VisibilityScopeV1 => ({
  version: 1,
  clauses: [[{ kind: 'workspace', workspaceId }]],
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('authorized public canonical surface', () => {
  it('does not export raw repository/read bypasses and rejects forged host capabilities', async () => {
    for (const forbidden of [
      'TaprootRepository',
      'createTaproot',
      'getEntity',
      'listEntities',
      'exportEntities',
      'searchEntities',
    ])
      expect(forbidden in publicApi).toBe(false);

    const directory = mkdtempSync(join(tmpdir(), 'taproot-surface-'));
    temporaryDirectories.push(directory);
    const db = new NodeSqliteDatabase(join(directory, 'surface.sqlite'));
    try {
      await initializeTaproot(db, options);
      const key = await writeKey();
      const capability = createTaprootHostWriteCapability(db, options, key);
      await bootstrapTaprootAuthorization(
        db,
        options,
        capability,
        installationId,
      );
      const guard = await createInstallationAuthorizationGuard(
        db,
        options,
        capability,
      );
      const writer = context(1, {
        capabilities: [KNOWLEDGE_WRITE_CAPABILITY],
      });
      expect(() =>
        createItem(
          db,
          { ...options, validators: [() => undefined] } as never,
          guard,
          writer,
          {
            id: 'Q1',
            authorization: policy(1, publicScope),
          },
        ),
      ).toThrow(InvalidAuthorizationError);
      expect(() =>
        createItem(
          db,
          options,
          { kind: 'taproot-installation-authorization-guard-v1' } as never,
          writer,
          {
            id: 'Q1',
            authorization: policy(1, publicScope),
          },
        ),
      ).toThrow(InvalidAuthorizationError);
      const other = new NodeSqliteDatabase(join(directory, 'other.sqlite'));
      try {
        await initializeTaproot(other, options);
        expect(() =>
          createTaprootHostWriteCapability(other, options, {
            type: 'secret',
            extractable: false,
            algorithm: { name: 'HMAC', hash: { name: 'SHA-1' } },
            usages: ['sign'],
          } as CryptoKey),
        ).toThrow(InvalidAuthorizationError);
      } finally {
        await other.close();
      }
    } finally {
      await db.close();
    }
  });

  it('enforces collection, history, audit, export, cursor and admin rules on persisted native SQLite', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'taproot-surface-native-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'surface.sqlite');
    let db = new NodeSqliteDatabase(path);
    await initializeTaproot(db, options);
    await db.close();
    db = new NodeSqliteDatabase(path);
    try {
      await exercise(db, await capability(db));
    } finally {
      await db.close();
    }
  });

  it('enforces the same surface on real Workerd D1', async () => {
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
      await exercise(db, await capability(db));
    } finally {
      await miniflare.dispose();
    }
  }, 30_000);
});

async function exercise(
  db: SqliteDatabaseLike,
  writeCapability: TaprootHostWriteCapability,
) {
  const raw = new TaprootRepository(db, options);
  const first = await raw.createItem({
    id: 'Q1',
    labels: { en: { language: 'en', value: 'needle alpha' } },
    requestId: 'request-visible',
  });
  const firstEdited = await raw.setDescription('Q1', 'en', 'visible body', {
    expectedRevision: first.newRevision,
    requestId: 'request-visible',
  });
  await raw.createItem({
    id: 'Q2',
    labels: { en: { language: 'en', value: 'needle classified' } },
    requestId: 'request-denied',
  });
  await raw.createItem({
    id: 'Q3',
    labels: { en: { language: 'en', value: 'needle omega' } },
    requestId: 'request-visible',
  });
  const revisions = await db
    .prepare(
      `SELECT entity_id, revision, content_hash FROM taproot_entity_revisions
       ORDER BY entity_id, revision`,
    )
    .all<{ entity_id: string; revision: number; content_hash: string }>();
  await bootstrapLegacyTaprootAuthorization(
    db,
    options,
    writeCapability,
    installationId,
    {
      entityCount: 3,
      revisionCount: 4,
      revisionManifestHash: await hash(
        JSON.stringify(
          revisions.results.map(({ entity_id, revision, content_hash }) => [
            entity_id,
            Number(revision),
            content_hash,
          ]),
        ),
      ),
    },
  );
  const adminAtOne = context(1, {
    capabilities: [SEARCH_ADMIN_CAPABILITY],
  });
  const byEntity = new Map<string, typeof revisions.results>();
  for (const row of revisions.results) {
    const values = byEntity.get(row.entity_id) ?? [];
    values.push(row);
    byEntity.set(row.entity_id, values);
  }
  const plan = await planTaprootAuthorizationBackfill(
    db,
    options,
    writeCapability,
    adminAtOne,
    [
      {
        entityId: 'Q1',
        revisions: byEntity.get('Q1')!.map((row) => ({
          revision: row.revision,
          contentHash: row.content_hash,
          workspaceId: 'workspace-1',
          ownerPrincipalId: 'principal-1',
          visibility:
            row.revision === 1
              ? workspace('workspace-2')
              : workspace('workspace-1'),
          statementRestrictions: {},
        })),
      },
      {
        entityId: 'Q2',
        revisions: byEntity.get('Q2')!.map((row) => ({
          revision: row.revision,
          contentHash: row.content_hash,
          workspaceId: 'workspace-2',
          ownerPrincipalId: 'principal-2',
          visibility: workspace('workspace-2'),
          statementRestrictions: {},
        })),
      },
      {
        entityId: 'Q3',
        revisions: byEntity.get('Q3')!.map((row) => ({
          revision: row.revision,
          contentHash: row.content_hash,
          workspaceId: null,
          ownerPrincipalId: 'principal-1',
          visibility: publicScope,
          statementRestrictions: {},
        })),
      },
    ],
  );
  await applyTaprootAuthorizationBackfill(
    db,
    options,
    writeCapability,
    adminAtOne,
    plan.planId,
  );

  const cursorCodec = await codec();
  const reader = createAuthorizedTaproot(db, options, context(2), {
    cursorCodec,
  });
  await expect(reader.getEntity('Q2')).rejects.toBeInstanceOf(
    AuthorizationDeniedError,
  );
  await expect(reader.getEntityRevision('Q1', 1)).rejects.toBeInstanceOf(
    AuthorizationDeniedError,
  );
  await expect(reader.getEntityRevision('Q1', 2)).resolves.toMatchObject({
    revision: 2,
  });
  const history = await reader.listEntityRevisions('Q1', { limit: 10 });
  expect(history.items.map(({ revision }) => revision)).toEqual([2]);

  const listed = await reader.listEntities({ limit: 1 });
  expect(listed.items.map(({ entityId }) => entityId)).toEqual(['Q1']);
  const listedNext = await reader.listEntities({
    limit: 1,
    cursor: listed.cursor!,
  });
  expect(listedNext.items.map(({ entityId }) => entityId)).toEqual(['Q3']);
  const searched = await reader.searchEntities('needle', { limit: 1 });
  expect(searched.items.map(({ value }) => value)).toEqual(['needle alpha']);
  const searchedNext = await reader.searchEntities('needle', {
    limit: 1,
    cursor: searched.cursor!,
  });
  expect(searchedNext.items.map(({ value }) => value)).toEqual([
    'needle omega',
  ]);
  await expect(
    reader.searchEntities('different-query', { cursor: searched.cursor! }),
  ).rejects.toBeInstanceOf(InvalidCursorError);
  await expect(
    reader.listEntities({
      cursor: `${listed.cursor![0] === 'A' ? 'B' : 'A'}${listed.cursor!.slice(1)}`,
    }),
  ).rejects.toBeInstanceOf(InvalidCursorError);
  const otherPrincipal = createAuthorizedTaproot(
    db,
    options,
    context(2, { principalId: 'principal-2' }),
    { cursorCodec },
  );
  await expect(
    otherPrincipal.listEntities({ cursor: listed.cursor! }),
  ).rejects.toBeInstanceOf(InvalidCursorError);

  const audits = await reader.listAuditEvents({ limit: 10 });
  expect(audits.items.every(({ entityId }) => entityId !== 'Q2')).toBe(true);
  expect(audits.items.map(({ revision }) => revision)).toContain(2);
  expect(
    audits.items.some(
      ({ entityId, revision }) => entityId === 'Q1' && revision === 1,
    ),
  ).toBe(false);
  await expect(reader.getAuditEvent(first.eventId)).rejects.toBeInstanceOf(
    AuthorizationDeniedError,
  );
  await expect(
    reader.getAuditEvent(firstEdited.eventId),
  ).resolves.toMatchObject({
    entityId: 'Q1',
    revision: 2,
  });
  const exported = await reader.exportEntities();
  expect(exported).toContain('needle alpha');
  expect(exported).toContain('needle omega');
  expect(exported).not.toContain('needle classified');

  await expect(reader.inspectEntityIntegrity('Q1')).rejects.toBeInstanceOf(
    AuthorizationDeniedError,
  );
  const admin = createAuthorizedTaproot(
    db,
    options,
    context(2, { capabilities: [SEARCH_ADMIN_CAPABILITY] }),
    { cursorCodec },
  );
  await expect(admin.inspectEntityIntegrity('Q1')).resolves.toMatchObject({
    valid: true,
  });
  await expect(admin.verifyAuditChain('Q1')).rejects.toBeInstanceOf(
    AuthorizationDeniedError,
  );
  const auditCursor = await reader.listAuditEvents({ limit: 1 });
  await expect(admin.repairEntityProjection('Q1')).resolves.toMatchObject({
    valid: true,
  });
  await expect(
    reader.searchEntities('needle', { cursor: searched.cursor! }),
  ).rejects.toBeInstanceOf(InvalidCursorError);
  await expect(
    reader.listAuditEvents({ cursor: auditCursor.cursor! }),
  ).rejects.toBeInstanceOf(InvalidCursorError);
}

function policy(
  expectedAuthorizationRevision: number,
  visibility: VisibilityScopeV1,
) {
  return {
    installationId,
    workspaceId: null,
    ownerPrincipalId: 'principal-1',
    visibility,
    statementRestrictions: {},
    expectedAuthorizationRevision,
  };
}

function context(
  authorizationRevision: number,
  overrides: Partial<AuthorizationContext> = {},
): AuthorizationContext {
  return {
    installationId,
    principalId: 'principal-1',
    activeWorkspaceId: 'workspace-1',
    workspaceIds: ['workspace-1'],
    capabilities: [],
    authorizationRevision,
    ...overrides,
  };
}

async function codec() {
  return createAuthorizationCursorCodec(
    await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
  );
}

async function writeKey() {
  return crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
}

async function capability(db: D1DatabaseLike) {
  return createTaprootHostWriteCapability(db, options, await writeKey());
}

async function hash(value: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
