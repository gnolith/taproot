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
  createAuthorizationCursorCodec,
  createAuthorizedTaproot,
  createItem,
  initializeTaproot,
  type AuthorizationContext,
  type CanonicalAuthorizationRecord,
  type EntityAuthorizationSource,
  type EntityId,
  type InstallationAuthorizationState,
  type VisibilityScopeV1,
} from '../src/index.js';
import { TaprootRepository } from '../src/repository.js';

const options = { baseIri: 'https://authorized-surface.example' };
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const publicScope: VisibilityScopeV1 = { version: 1, clauses: [] };
const workspace = (workspaceId: string): VisibilityScopeV1 => ({
  version: 1,
  clauses: [[{ kind: 'workspace', workspaceId }]],
});

class Policies implements EntityAuthorizationSource {
  state: InstallationAuthorizationState = {
    installationId: 'installation-1',
    authorizationRevision: 9,
  };
  current = new Map<EntityId, CanonicalAuthorizationRecord>();
  historical = new Map<string, CanonicalAuthorizationRecord>();

  getInstallationAuthorizationState() {
    return Promise.resolve(this.state);
  }
  getEntityAuthorization(entityId: EntityId) {
    return Promise.resolve(this.current.get(entityId) ?? null);
  }
  getEntityRevisionAuthorization(entityId: EntityId, revision: number) {
    return Promise.resolve(
      this.historical.get(`${entityId}@${revision}`) ??
        this.current.get(entityId) ??
        null,
    );
  }
}

const context = (
  overrides: Partial<AuthorizationContext> = {},
): AuthorizationContext => ({
  installationId: 'installation-1',
  principalId: 'principal-1',
  activeWorkspaceId: 'workspace-1',
  workspaceIds: ['workspace-1'],
  capabilities: [],
  authorizationRevision: 9,
  ...overrides,
});

async function codec() {
  return createAuthorizationCursorCodec(
    await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
  );
}

async function exercise(db: SqliteDatabaseLike) {
  await initializeTaproot(db, options);
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

  const policies = new Policies();
  const allowed: CanonicalAuthorizationRecord = {
    installationId: 'installation-1',
    authorizationRevision: 9,
    visibility: workspace('workspace-1'),
  };
  const denied: CanonicalAuthorizationRecord = {
    installationId: 'installation-1',
    authorizationRevision: 9,
    visibility: workspace('workspace-2'),
  };
  policies.current.set('Q1', allowed);
  policies.current.set('Q2', denied);
  policies.current.set('Q3', { ...allowed, visibility: publicScope });
  policies.historical.set('Q1@1', denied);
  policies.historical.set('Q1@2', allowed);

  const cursorCodec = await codec();
  const reader = createAuthorizedTaproot(db, options, context(), policies, {
    cursorCodec,
  });

  await expect(reader.getEntity('Q2')).rejects.toMatchObject({
    code: 'AUTHORIZATION_DENIED',
    message: 'Authorization denied',
  });
  await expect(reader.getEntityRevision('Q1', 1)).rejects.toBeInstanceOf(
    AuthorizationDeniedError,
  );
  await expect(reader.getEntityRevision('Q1', 2)).resolves.toMatchObject({
    revision: 2,
  });

  const history = await reader.listEntityRevisions('Q1', { limit: 10 });
  expect(history.items.map((entry) => entry.revision)).toEqual([2]);

  const listed = await reader.listEntities({ limit: 1 });
  expect(listed.items.map((entry) => entry.entityId)).toEqual(['Q1']);
  expect(listed.cursor).toBeTypeOf('string');
  expect(listed.cursor).not.toContain('Q1');
  const listedNext = await reader.listEntities({
    limit: 1,
    cursor: listed.cursor!,
  });
  expect(listedNext.items.map((entry) => entry.entityId)).toEqual(['Q3']);

  const searched = await reader.searchEntities('needle', { limit: 1 });
  expect(searched.items.map((entry) => entry.value)).toEqual(['needle alpha']);
  expect(searched.cursor).toBeTypeOf('string');
  expect(searched.cursor).not.toContain('needle');
  const searchedNext = await reader.searchEntities('needle', {
    limit: 1,
    cursor: searched.cursor!,
  });
  expect(searchedNext.items.map((entry) => entry.value)).toEqual([
    'needle omega',
  ]);
  await expect(
    reader.searchEntities('different-query', {
      limit: 1,
      cursor: searched.cursor!,
    }),
  ).rejects.toBeInstanceOf(InvalidCursorError);
  await expect(
    reader.listEntities({
      cursor: `${listed.cursor![0] === 'A' ? 'B' : 'A'}${listed.cursor!.slice(1)}`,
    }),
  ).rejects.toMatchObject({ message: 'Cursor is invalid' });
  const otherPrincipal = createAuthorizedTaproot(
    db,
    options,
    context({ principalId: 'principal-2' }),
    policies,
    { cursorCodec },
  );
  await expect(
    otherPrincipal.listEntities({ cursor: listed.cursor! }),
  ).rejects.toBeInstanceOf(InvalidCursorError);

  const audits = await reader.listAuditEvents({ limit: 10 });
  expect(audits.items.every((event) => event.entityId !== 'Q2')).toBe(true);
  expect(audits.items.map((event) => event.revision)).toContain(2);
  expect(
    audits.items.some(
      (event) => event.entityId === 'Q1' && event.revision === 1,
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
    context({ capabilities: [SEARCH_ADMIN_CAPABILITY] }),
    policies,
    { cursorCodec },
  );
  await expect(admin.inspectEntityIntegrity('Q1')).resolves.toMatchObject({
    valid: true,
  });
  await expect(admin.inspectEntityIntegrity('Q2')).rejects.toBeInstanceOf(
    AuthorizationDeniedError,
  );
  await expect(admin.verifyAuditChain('Q1')).rejects.toBeInstanceOf(
    AuthorizationDeniedError,
  );
  policies.historical.set('Q1@1', allowed);
  await expect(admin.verifyAuditChain('Q1')).resolves.toMatchObject({
    valid: true,
  });

  let searchPolicyReads = 0;
  const changingSearchSource: EntityAuthorizationSource = {
    getInstallationAuthorizationState: () => Promise.resolve(policies.state),
    getEntityAuthorization: () => {
      searchPolicyReads += 1;
      return Promise.resolve(searchPolicyReads === 1 ? allowed : denied);
    },
    getEntityRevisionAuthorization: () => Promise.resolve(allowed),
  };
  const changingSearch = createAuthorizedTaproot(
    db,
    options,
    context(),
    changingSearchSource,
    { cursorCodec },
  );
  await expect(changingSearch.searchEntities('alpha')).resolves.toMatchObject({
    items: [],
  });

  policies.current.set('Q1', denied);
  await expect(reader.getEntityRevision('Q1', 2)).rejects.toBeInstanceOf(
    AuthorizationDeniedError,
  );
  policies.current.set('Q1', allowed);
  policies.state = { ...policies.state, authorizationRevision: 10 };
  await expect(reader.listEntities()).rejects.toBeInstanceOf(
    AuthorizationDeniedError,
  );

  policies.state = { ...policies.state, authorizationRevision: 9 };
  await raw.createItem({ id: 'Q4' });
  policies.current.set('Q4', allowed);
  await expect(
    reader.listEntities({ cursor: listed.cursor! }),
  ).rejects.toBeInstanceOf(InvalidCursorError);
}

describe('authorized public canonical surface', () => {
  it('does not export raw repository/read bypasses and rejects validator callbacks on writes', async () => {
    for (const name of [
      'TaprootRepository',
      'createTaproot',
      'getEntity',
      'getEntityRevision',
      'resolveEntity',
      'listEntityRevisions',
      'listEntityRevisionsPage',
      'listEntities',
      'searchEntities',
      'searchEntitiesPage',
      'getAuditEvent',
      'listAuditEvents',
      'exportEntities',
      'inspectEntityIntegrity',
      'inspectTaprootIntegrity',
      'verifyAuditChain',
      'repairEntityProjection',
    ])
      expect(publicApi).not.toHaveProperty(name);

    const db = new NodeSqliteDatabase(':memory:');
    try {
      await initializeTaproot(db, options);
      expect(() =>
        createItem(db, { ...options, validators: [] } as never, { id: 'Q1' }),
      ).toThrow(InvalidAuthorizationError);
      expect(() =>
        createItem(db, { ...options, maxEntityBytes: 1 } as never, {
          id: 'Q1',
        }),
      ).toThrow(InvalidAuthorizationError);
      expect(() =>
        createItem(db, { ...options, factory: {} } as never, { id: 'Q1' }),
      ).toThrow(InvalidAuthorizationError);
      expect(() =>
        createAuthorizedTaproot(db, options, context(), new Policies(), {
          cursorCodec: { kind: 'taproot-aes-gcm-v1' },
        }),
      ).toThrow(InvalidAuthorizationError);
    } finally {
      await db.close();
    }
  });

  it('enforces collection, history, audit, export, cursor and admin rules on persisted native SQLite', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'taproot-authorized-'));
    temporaryDirectories.push(directory);
    const db = new NodeSqliteDatabase(join(directory, 'taproot.sqlite'));
    try {
      await exercise(db);
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
      await exercise(db);
    } finally {
      await miniflare.dispose();
    }
  }, 30_000);
});
