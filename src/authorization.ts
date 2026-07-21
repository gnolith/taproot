import type { SqliteDatabaseLike } from '@gnolith/diamond';
import {
  AuthorizationDeniedError,
  InvalidAuthorizationError,
} from './errors.js';
import { TaprootRepository } from './repository.js';
import type {
  EntityId,
  ResolvedEntity,
  RevisionEntry,
  StoredEntity,
  TaprootOptions,
} from './types.js';

export const SEARCH_ADMIN_CAPABILITY = 'search:admin' as const;

export interface AuthorizationContext {
  installationId: string;
  principalId: string;
  activeWorkspaceId: string | null;
  workspaceIds: readonly string[];
  capabilities: readonly string[];
  authorizationRevision: number;
}

export type VisibilityAtomV1 =
  | { kind: 'public' }
  | { kind: 'principal'; principalId: string }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'capability'; capability: string };

export interface VisibilityScopeV1 {
  version: 1;
  /** AND of clauses; each clause is an OR of its atoms. Empty means public. */
  clauses: readonly (readonly VisibilityAtomV1[])[];
}

export interface CanonicalAuthorizationRecord {
  installationId: string;
  authorizationRevision: number;
  visibility: VisibilityScopeV1;
}

export interface InstallationAuthorizationState {
  installationId: string;
  authorizationRevision: number;
}

/**
 * The canonical domain owns persistence of these records. Implementations must
 * return current state on every call; request-local stale caches are unsafe.
 */
export interface EntityAuthorizationSource {
  getInstallationAuthorizationState(): Promise<InstallationAuthorizationState>;
  getEntityAuthorization(
    entityId: EntityId,
    revision?: number,
  ): Promise<CanonicalAuthorizationRecord | null>;
}

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_CLAUSES = 64;
const MAX_ATOMS_PER_CLAUSE = 64;

export function normalizeAuthorizationContext(
  value: AuthorizationContext,
): AuthorizationContext {
  if (!isRecord(value)) invalid('authorization context must be an object');
  exactKeys(value, [
    'installationId',
    'principalId',
    'activeWorkspaceId',
    'workspaceIds',
    'capabilities',
    'authorizationRevision',
  ]);
  const installationId = identifier(value.installationId, 'installationId');
  const principalId = identifier(value.principalId, 'principalId');
  const activeWorkspaceId =
    value.activeWorkspaceId === null
      ? null
      : identifier(value.activeWorkspaceId, 'activeWorkspaceId');
  const workspaceIds = stringSet(value.workspaceIds, 'workspaceIds');
  const capabilities = stringSet(value.capabilities, 'capabilities');
  const authorizationRevision = revision(
    value.authorizationRevision,
    'authorizationRevision',
  );
  if (activeWorkspaceId !== null && !workspaceIds.includes(activeWorkspaceId))
    invalid('activeWorkspaceId must be present in workspaceIds');
  return {
    installationId,
    principalId,
    activeWorkspaceId,
    workspaceIds,
    capabilities,
    authorizationRevision,
  };
}

export function normalizeVisibilityScope(
  value: VisibilityScopeV1,
): VisibilityScopeV1 {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.clauses))
    invalid('visibility scope must be a version 1 CNF object');
  exactKeys(value, ['version', 'clauses']);
  if (value.clauses.length > MAX_CLAUSES)
    invalid(`visibility scope exceeds ${MAX_CLAUSES} clauses`);
  const clauses = new Map<string, VisibilityAtomV1[]>();
  for (const rawClause of value.clauses) {
    if (!Array.isArray(rawClause) || rawClause.length === 0)
      invalid('visibility clauses must contain at least one atom');
    if (rawClause.length > MAX_ATOMS_PER_CLAUSE)
      invalid(`visibility clause exceeds ${MAX_ATOMS_PER_CLAUSE} atoms`);
    const atoms = new Map<string, VisibilityAtomV1>();
    let publicClause = false;
    for (const rawAtom of rawClause) {
      const atom = normalizeAtom(rawAtom);
      if (atom.kind === 'public') {
        publicClause = true;
        break;
      }
      atoms.set(serializeAtom(atom), atom);
    }
    // A public OR-clause is true and therefore has no effect in an AND scope.
    if (publicClause) continue;
    const sorted = [...atoms.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([, atom]) => atom);
    if (sorted.length === 0)
      invalid('visibility clause is empty after normalization');
    clauses.set(JSON.stringify(sorted), sorted);
  }
  return {
    version: 1,
    clauses: [...clauses.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([, clause]) => clause),
  };
}

export function serializeVisibilityScope(scope: VisibilityScopeV1): string {
  return JSON.stringify(normalizeVisibilityScope(scope));
}

export async function visibilityScopeFingerprint(
  scope: VisibilityScopeV1,
): Promise<string> {
  const bytes = new TextEncoder().encode(serializeVisibilityScope(scope));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** CNF intersection is lossless clause concatenation followed by normalization. */
export function intersectVisibilityScopes(
  ...scopes: readonly VisibilityScopeV1[]
): VisibilityScopeV1 {
  return normalizeVisibilityScope({
    version: 1,
    clauses: scopes.flatMap((scope) => normalizeVisibilityScope(scope).clauses),
  });
}

export function isVisibleTo(
  rawScope: VisibilityScopeV1,
  rawContext: AuthorizationContext,
): boolean {
  const scope = normalizeVisibilityScope(rawScope);
  const context = normalizeAuthorizationContext(rawContext);
  const workspaces = new Set(context.workspaceIds);
  const capabilities = new Set(context.capabilities);
  return scope.clauses.every((clause) =>
    clause.some((atom) => {
      switch (atom.kind) {
        case 'public':
          return true;
        case 'principal':
          return atom.principalId === context.principalId;
        case 'workspace':
          return workspaces.has(atom.workspaceId);
        case 'capability':
          return capabilities.has(atom.capability);
      }
    }),
  );
}

export function hasSearchAdministration(
  context: AuthorizationContext,
): boolean {
  return normalizeAuthorizationContext(context).capabilities.includes(
    SEARCH_ADMIN_CAPABILITY,
  );
}

export function requireSearchAdministration(
  context: AuthorizationContext,
): void {
  if (!hasSearchAdministration(context))
    throw new AuthorizationDeniedError('Authorization denied');
}

/**
 * Authorization-enforcing canonical read boundary. The context and policy
 * source are mandatory, and policy is checked both before and after hydration.
 */
export class AuthorizedTaprootReader {
  readonly #repository: TaprootRepository;
  readonly #context: AuthorizationContext;
  readonly #authorization: EntityAuthorizationSource;

  constructor(
    db: SqliteDatabaseLike,
    options: TaprootOptions,
    context: AuthorizationContext,
    authorization: EntityAuthorizationSource,
  ) {
    this.#repository = new TaprootRepository(db, options);
    this.#context = normalizeAuthorizationContext(context);
    if (!authorization || typeof authorization !== 'object')
      invalid('authorization source is required');
    this.#authorization = authorization;
  }

  async getEntity(id: EntityId): Promise<StoredEntity> {
    return this.#authorizedHydration(id, undefined, () =>
      this.#repository.getEntity(id),
    );
  }

  async getEntityRevision(
    id: EntityId,
    revisionNumber: number,
  ): Promise<RevisionEntry> {
    return this.#authorizedHydration(id, revisionNumber, () =>
      this.#repository.getEntityRevision(id, revisionNumber),
    );
  }

  async resolveEntity(id: EntityId, maxDepth = 100): Promise<ResolvedEntity> {
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 1000)
      throw new RangeError('maxDepth must be an integer from 0 through 1000');
    const redirects: EntityId[] = [];
    const seen = new Set<EntityId>();
    let current = id;
    for (;;) {
      if (seen.has(current))
        throw new AuthorizationDeniedError('Authorization denied');
      seen.add(current);
      const stored = await this.getEntity(current);
      if (!stored.redirectTo)
        return { ...stored, requestedId: id, resolvedId: current, redirects };
      if (redirects.length >= maxDepth)
        throw new AuthorizationDeniedError('Authorization denied');
      redirects.push(stored.redirectTo);
      current = stored.redirectTo;
    }
  }

  async #authorizedHydration<T>(
    entityId: EntityId,
    revisionNumber: number | undefined,
    hydrate: () => Promise<T>,
  ): Promise<T> {
    const before = await this.#readAndAuthorize(entityId, revisionNumber);
    const hydrated = await hydrate();
    const after = await this.#readAndAuthorize(entityId, revisionNumber);
    if (
      before.state.authorizationRevision !==
        after.state.authorizationRevision ||
      before.record.authorizationRevision !==
        after.record.authorizationRevision ||
      serializeVisibilityScope(before.record.visibility) !==
        serializeVisibilityScope(after.record.visibility)
    )
      throw new AuthorizationDeniedError('Authorization denied');
    return hydrated;
  }

  async #readAndAuthorize(entityId: EntityId, revisionNumber?: number) {
    let state: InstallationAuthorizationState;
    let record: CanonicalAuthorizationRecord | null;
    try {
      [state, record] = await Promise.all([
        this.#authorization.getInstallationAuthorizationState(),
        this.#authorization.getEntityAuthorization(entityId, revisionNumber),
      ]);
    } catch {
      throw new AuthorizationDeniedError('Authorization denied');
    }
    if (!record) throw new AuthorizationDeniedError('Authorization denied');
    const normalizedState = normalizeInstallationState(state);
    const normalizedRecord = normalizeAuthorizationRecord(record);
    if (
      normalizedState.installationId !== this.#context.installationId ||
      normalizedRecord.installationId !== this.#context.installationId ||
      normalizedState.authorizationRevision !==
        this.#context.authorizationRevision ||
      normalizedRecord.authorizationRevision >
        normalizedState.authorizationRevision ||
      !isVisibleTo(normalizedRecord.visibility, this.#context)
    )
      throw new AuthorizationDeniedError('Authorization denied');
    return { state: normalizedState, record: normalizedRecord };
  }
}

export function createAuthorizedTaproot(
  db: SqliteDatabaseLike,
  options: TaprootOptions,
  context: AuthorizationContext,
  authorization: EntityAuthorizationSource,
): AuthorizedTaprootReader {
  return new AuthorizedTaprootReader(db, options, context, authorization);
}

function normalizeInstallationState(
  value: InstallationAuthorizationState,
): InstallationAuthorizationState {
  if (!isRecord(value)) invalid('authorization state must be an object');
  exactKeys(value, ['installationId', 'authorizationRevision']);
  return {
    installationId: identifier(value.installationId, 'installationId'),
    authorizationRevision: revision(
      value.authorizationRevision,
      'authorizationRevision',
    ),
  };
}

function normalizeAuthorizationRecord(
  value: CanonicalAuthorizationRecord,
): CanonicalAuthorizationRecord {
  if (!isRecord(value)) invalid('authorization record must be an object');
  exactKeys(value, ['installationId', 'authorizationRevision', 'visibility']);
  return {
    installationId: identifier(value.installationId, 'installationId'),
    authorizationRevision: revision(
      value.authorizationRevision,
      'authorizationRevision',
    ),
    visibility: normalizeVisibilityScope(value.visibility),
  };
}

function normalizeAtom(value: unknown): VisibilityAtomV1 {
  if (!isRecord(value) || typeof value.kind !== 'string')
    invalid('visibility atom must be an object');
  switch (value.kind) {
    case 'public':
      if (Object.keys(value).length !== 1)
        invalid('public atom has unknown fields');
      return { kind: 'public' };
    case 'principal':
      exactKeys(value, ['kind', 'principalId']);
      return {
        kind: 'principal',
        principalId: identifier(value.principalId, 'principalId'),
      };
    case 'workspace':
      exactKeys(value, ['kind', 'workspaceId']);
      return {
        kind: 'workspace',
        workspaceId: identifier(value.workspaceId, 'workspaceId'),
      };
    case 'capability':
      exactKeys(value, ['kind', 'capability']);
      return {
        kind: 'capability',
        capability: identifier(value.capability, 'capability'),
      };
    default:
      invalid('visibility atom kind is not supported');
  }
}

function serializeAtom(atom: VisibilityAtomV1): string {
  return JSON.stringify(atom);
}

function stringSet(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 256)
    invalid(`${field} must be an array with at most 256 entries`);
  return [...new Set(value.map((entry) => identifier(entry, field)))].sort(
    compareCodeUnits,
  );
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(`${field} must be a string`);
  const normalized = value.normalize('NFC');
  if (
    normalized.length === 0 ||
    normalized.length > MAX_IDENTIFIER_LENGTH ||
    normalized.trim() !== normalized ||
    hasControlCharacter(normalized)
  )
    invalid(`${field} is invalid`);
  return normalized;
}

function revision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    invalid(`${field} must be a non-negative safe integer`);
  return value as number;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  )
    invalid('visibility atom has unknown or missing fields');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function invalid(message: string): never {
  throw new InvalidAuthorizationError(message);
}
