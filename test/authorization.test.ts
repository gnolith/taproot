import { describe, expect, it } from 'vitest';
import {
  AuthorizationDeniedError,
  InvalidAuthorizationError,
  SEARCH_ADMIN_CAPABILITY,
  hasSearchAdministration,
  intersectVisibilityScopes,
  isVisibleTo,
  normalizeAuthorizationContext,
  normalizeCanonicalAuthorizationPolicy,
  normalizeVisibilityScope,
  requireSearchAdministration,
  serializeVisibilityScope,
  visibilityScopeFingerprint,
  type AuthorizationContext,
  type VisibilityScopeV1,
} from '../src/index.js';

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

  it('rejects malformed scopes, contexts, and incomplete policy maps instead of broadening them', () => {
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
    const sparseWorkspaces = new Array<string>(1);
    expect(() =>
      normalizeAuthorizationContext(
        context({ workspaceIds: sparseWorkspaces, activeWorkspaceId: null }),
      ),
    ).toThrow(InvalidAuthorizationError);
    expect(() =>
      normalizeCanonicalAuthorizationPolicy({
        installationId: 'installation-1',
        workspaceId: 'workspace-1',
        ownerPrincipalId: 'principal-1',
        visibility: { version: 1, clauses: [] },
        statementRestrictions: { statement: new Array(1) },
        expectedAuthorizationRevision: 1,
      }),
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
