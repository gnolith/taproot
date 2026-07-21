import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthorizationDeniedError,
  InvalidAuthorizationError,
  SEARCH_ADMIN_CAPABILITY,
  TaprootRepository,
  createAuthorizedTaproot,
  hasSearchAdministration,
  initializeTaproot,
  intersectVisibilityScopes,
  isVisibleTo,
  normalizeAuthorizationContext,
  normalizeVisibilityScope,
  requireSearchAdministration,
  serializeVisibilityScope,
  visibilityScopeFingerprint,
  type AuthorizationContext,
  type CanonicalAuthorizationRecord,
  type EntityAuthorizationSource,
  type EntityId,
  type InstallationAuthorizationState,
  type VisibilityScopeV1,
} from '../src/index.js';

const options = { baseIri: 'https://knowledge.example' };
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const context = (
  overrides: Partial<AuthorizationContext> = {},
): AuthorizationContext => ({
  installationId: 'installation-1',
  principalId: 'principal-1',
  activeWorkspaceId: 'workspace-1',
  workspaceIds: ['workspace-1'],
  capabilities: [],
  authorizationRevision: 7,
  ...overrides,
});

const workspaceScope: VisibilityScopeV1 = {
  version: 1,
  clauses: [[{ kind: 'workspace', workspaceId: 'workspace-1' }]],
};

class MutableAuthorizationSource implements EntityAuthorizationSource {
  state: InstallationAuthorizationState = {
    installationId: 'installation-1',
    authorizationRevision: 7,
  };
  records = new Map<EntityId, CanonicalAuthorizationRecord>();
  onSecondRecordRead?: () => void;
  recordReads = 0;

  getInstallationAuthorizationState() {
    return Promise.resolve(this.state);
  }

  getEntityAuthorization(entityId: EntityId) {
    this.recordReads += 1;
    if (this.recordReads === 2) this.onSecondRecordRead?.();
    return Promise.resolve(this.records.get(entityId) ?? null);
  }
}

describe('authorization contract values', () => {
  it('normalizes deterministically, fingerprints canonically, and intersects by CNF clause concatenation', async () => {
    const left: VisibilityScopeV1 = {
      version: 1,
      clauses: [
        [
          { kind: 'workspace', workspaceId: 'workspace-1' },
          { kind: 'principal', principalId: 'principal-1' },
          { kind: 'workspace', workspaceId: 'workspace-1' },
        ],
        [{ kind: 'public' }],
      ],
    };
    const reordered: VisibilityScopeV1 = {
      version: 1,
      clauses: [
        [
          { kind: 'principal', principalId: 'principal-1' },
          { kind: 'workspace', workspaceId: 'workspace-1' },
        ],
      ],
    };
    expect(serializeVisibilityScope(left)).toBe(
      serializeVisibilityScope(reordered),
    );
    expect(await visibilityScopeFingerprint(left)).toBe(
      await visibilityScopeFingerprint(reordered),
    );

    const restricted = intersectVisibilityScopes(left, {
      version: 1,
      clauses: [[{ kind: 'capability', capability: 'knowledge:read' }]],
    });
    expect(restricted.clauses).toHaveLength(2);
    expect(isVisibleTo(restricted, context())).toBe(false);
    expect(
      isVisibleTo(restricted, context({ capabilities: ['knowledge:read'] })),
    ).toBe(true);
  });

  it('rejects malformed scopes and contexts instead of broadening them', () => {
    expect(() =>
      normalizeVisibilityScope({ version: 1, clauses: [[]] }),
    ).toThrow(InvalidAuthorizationError);
    expect(() =>
      normalizeVisibilityScope({
        version: 1,
        clauses: [[{ kind: 'workspace', workspaceId: ' workspace-1' }]],
      }),
    ).toThrow(InvalidAuthorizationError);
    expect(() =>
      normalizeAuthorizationContext(
        context({ activeWorkspaceId: 'workspace-2' }),
      ),
    ).toThrow(InvalidAuthorizationError);
    expect(() =>
      normalizeAuthorizationContext({
        ...context(),
        injectedAuthority: true,
      } as AuthorizationContext),
    ).toThrow(InvalidAuthorizationError);
  });

  it('grants search administration only through the exact capability', () => {
    for (const capabilities of [['admin'], ['administrator'], ['assistant']]) {
      const candidate = context({ capabilities });
      expect(hasSearchAdministration(candidate)).toBe(false);
      expect(() => requireSearchAdministration(candidate)).toThrow(
        AuthorizationDeniedError,
      );
    }
    expect(
      hasSearchAdministration(
        context({ capabilities: [SEARCH_ADMIN_CAPABILITY] }),
      ),
    ).toBe(true);
  });
});

describe('authorized canonical reads on a persisted native SQLite file', () => {
  it('fails closed across scope, installation, revision, and hydration changes', async () => {
    const environment = await createEnvironment();
    try {
      const repository = new TaprootRepository(environment.db, options);
      await repository.createItem({
        id: 'Q1',
        labels: { en: { language: 'en', value: 'private text' } },
      });
      const source = new MutableAuthorizationSource();
      source.records.set('Q1', {
        installationId: 'installation-1',
        authorizationRevision: 7,
        visibility: workspaceScope,
      });

      const authorized = createAuthorizedTaproot(
        environment.db,
        options,
        context(),
        source,
      );
      await expect(authorized.getEntity('Q1')).resolves.toMatchObject({
        entity: { id: 'Q1' },
      });

      const deniedSource = new MutableAuthorizationSource();
      deniedSource.records.set('Q1', {
        installationId: 'installation-1',
        authorizationRevision: 7,
        visibility: {
          version: 1,
          clauses: [[{ kind: 'principal', principalId: 'somebody-else' }]],
        },
      });
      await expect(
        createAuthorizedTaproot(
          environment.db,
          options,
          context(),
          deniedSource,
        ).getEntity('Q1'),
      ).rejects.toMatchObject({
        code: 'AUTHORIZATION_DENIED',
        message: 'Authorization denied',
      });

      for (const invalidContext of [
        context({ installationId: 'installation-2' }),
        context({ authorizationRevision: 6 }),
      ]) {
        await expect(
          createAuthorizedTaproot(
            environment.db,
            options,
            invalidContext,
            source,
          ).getEntity('Q1'),
        ).rejects.toBeInstanceOf(AuthorizationDeniedError);
      }

      const changing = new MutableAuthorizationSource();
      changing.records.set('Q1', {
        installationId: 'installation-1',
        authorizationRevision: 7,
        visibility: workspaceScope,
      });
      changing.onSecondRecordRead = () => {
        changing.state = { ...changing.state, authorizationRevision: 8 };
        changing.records.set('Q1', {
          installationId: 'installation-1',
          authorizationRevision: 8,
          visibility: workspaceScope,
        });
      };
      await expect(
        createAuthorizedTaproot(
          environment.db,
          options,
          context(),
          changing,
        ).getEntity('Q1'),
      ).rejects.toBeInstanceOf(AuthorizationDeniedError);

      const missing = new MutableAuthorizationSource();
      await expect(
        createAuthorizedTaproot(
          environment.db,
          options,
          context(),
          missing,
        ).getEntity('Q1'),
      ).rejects.toBeInstanceOf(AuthorizationDeniedError);

      const failing: EntityAuthorizationSource = {
        getInstallationAuthorizationState: () =>
          Promise.reject(new Error('secret policy backend detail')),
        getEntityAuthorization: () =>
          Promise.resolve(source.records.get('Q1')!),
      };
      await expect(
        createAuthorizedTaproot(
          environment.db,
          options,
          context(),
          failing,
        ).getEntity('Q1'),
      ).rejects.toMatchObject({
        message: 'Authorization denied',
      });
    } finally {
      await environment.dispose();
    }
  });
});

async function createEnvironment() {
  const directory = mkdtempSync(join(tmpdir(), 'taproot-auth-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'taproot.sqlite');
  let db = new NodeSqliteDatabase(path);
  await initializeTaproot(db, options);
  await db.close();
  db = new NodeSqliteDatabase(path);
  return { db, dispose: () => db.close() };
}
