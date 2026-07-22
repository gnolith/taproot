import type { SqliteDatabaseLike } from '@gnolith/diamond';
import {
  AuthorizationDeniedError,
  InvalidAuthorizationError,
  InvalidCursorError,
} from './errors.js';
import { exportEntityJson } from './canonical.js';
import { TaprootRepository } from './repository.js';
import type {
  AuditEvent,
  EntityIntegrityReport,
  EntityId,
  EntityListEntry,
  EntityType,
  Page,
  ResolvedEntity,
  RevisionEntry,
  SearchResult,
  StoredEntity,
  TaprootOptions,
  EditMetadata,
} from './types.js';
import type {
  ListAuditOptions,
  ListEntitiesOptions,
  SearchOptions,
} from './repository.js';

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
  /** Current canonical policy. Deleted/missing current records return null. */
  getEntityAuthorization(
    entityId: EntityId,
  ): Promise<CanonicalAuthorizationRecord | null>;
  /** Historical restriction, always intersected with current policy. */
  getEntityRevisionAuthorization(
    entityId: EntityId,
    revision: number,
  ): Promise<CanonicalAuthorizationRecord | null>;
}

/**
 * Authenticated, opaque cursor codec issued by the host from a non-extractable
 * AES-GCM key. Request, MCP, and query arguments must never contain this key.
 */
export interface AuthorizationCursorCodec {
  readonly kind: 'taproot-aes-gcm-v1';
}

const cursorCodecs = new WeakMap<object, CryptoKey>();

export function createAuthorizationCursorCodec(
  key: CryptoKey,
): AuthorizationCursorCodec {
  if (
    key.type !== 'secret' ||
    key.extractable ||
    key.algorithm.name !== 'AES-GCM' ||
    !key.usages.includes('encrypt') ||
    !key.usages.includes('decrypt')
  )
    invalid(
      'cursor key must be a non-extractable AES-GCM key with encrypt/decrypt usages',
    );
  const codec = Object.freeze({ kind: 'taproot-aes-gcm-v1' as const });
  cursorCodecs.set(codec, key);
  return codec;
}

export interface AuthorizedTaprootOptions {
  /** Host-issued capability used only for authenticated, opaque pagination. */
  cursorCodec: AuthorizationCursorCodec;
}

export type AuthorizedListEntitiesOptions = Omit<
  ListEntitiesOptions,
  'cursor'
> & { cursor?: string };
export type AuthorizedSearchOptions = Omit<SearchOptions, 'cursor'> & {
  cursor?: string;
};
export type AuthorizedListAuditOptions = Omit<ListAuditOptions, 'cursor'> & {
  cursor?: string;
};

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_CLAUSES = 64;
const MAX_ATOMS_PER_CLAUSE = 64;
const CURSOR_AAD = new TextEncoder().encode(
  'taproot-authorized-cursor-v1',
).buffer;
const CURSOR_PLAINTEXT_BYTES = 1024;

interface AuthorizationCursorPayload {
  version: 1;
  binding: string;
  generation: string;
  position: unknown;
}

interface EntityPosition {
  entityType: EntityType;
  numericId: number;
}

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
  readonly #db: SqliteDatabaseLike;
  readonly #repository: TaprootRepository;
  readonly #context: AuthorizationContext;
  readonly #authorization: EntityAuthorizationSource;
  readonly #cursorCodec: AuthorizationCursorCodec;

  constructor(
    db: SqliteDatabaseLike,
    options: TaprootOptions,
    context: AuthorizationContext,
    authorization: EntityAuthorizationSource,
    authorizedOptions: AuthorizedTaprootOptions,
  ) {
    this.#db = db;
    this.#repository = new TaprootRepository(db, options);
    this.#context = normalizeAuthorizationContext(context);
    if (!authorization || typeof authorization !== 'object')
      invalid('authorization source is required');
    this.#authorization = authorization;
    if (!isRecord(authorizedOptions))
      invalid('authorized options are required');
    exactKeys(authorizedOptions, ['cursorCodec']);
    if (!cursorCodecs.has(authorizedOptions.cursorCodec))
      invalid('host-issued cursor codec is required');
    this.#cursorCodec = authorizedOptions.cursorCodec;
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

  async listEntityRevisions(
    id: EntityId,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<Page<RevisionEntry>> {
    const limit = authorizedLimit(options.limit, 50);
    const binding = await this.#binding('entity-revisions', { id });
    const generation = await this.#generation();
    let before = Number.MAX_SAFE_INTEGER;
    if (options.cursor) {
      const cursor = await this.#decodeCursor(
        options.cursor,
        binding,
        generation,
      );
      before = cursorNumber(cursor.position, 'revision');
    }
    await this.#assertContextCurrent();
    const items: RevisionEntry[] = [];
    let exhausted = false;
    while (items.length < limit && !exhausted) {
      const batch = await this.#db
        .prepare(
          `SELECT revision FROM taproot_entity_revisions
           WHERE entity_id = ? AND revision < ?
           ORDER BY revision DESC LIMIT ?`,
        )
        .bind(id, before, scanLimit(limit - items.length))
        .all<{ revision: number }>();
      exhausted = batch.results.length < scanLimit(limit - items.length);
      for (let index = 0; index < batch.results.length; index += 1) {
        const candidate = batch.results[index]!;
        before = candidate.revision;
        try {
          items.push(
            await this.#authorizedHydration(id, candidate.revision, () =>
              this.#repository.getEntityRevision(id, candidate.revision),
            ),
          );
        } catch (error) {
          if (!(error instanceof AuthorizationDeniedError)) throw error;
        }
        if (items.length === limit) {
          if (index < batch.results.length - 1) exhausted = false;
          break;
        }
      }
      if (!batch.results.length) exhausted = true;
    }
    await this.#reauthorize(items.map(() => id));
    await this.#assertGeneration(generation);
    return {
      items,
      cursor:
        !exhausted && items.length
          ? await this.#encodeCursor(binding, generation, { revision: before })
          : null,
    };
  }

  async listEntities(
    options: AuthorizedListEntitiesOptions = {},
  ): Promise<Page<EntityListEntry>> {
    const limit = authorizedLimit(options.limit, 50);
    const filter = {
      type: options.type ?? null,
      includeDeleted: options.includeDeleted ?? false,
    };
    const binding = await this.#binding('entities', filter);
    const generation = await this.#generation();
    let position: EntityPosition | null = null;
    if (options.cursor) {
      const cursor = await this.#decodeCursor(
        options.cursor,
        binding,
        generation,
      );
      position = entityPosition(cursor.position);
    }
    await this.#assertContextCurrent();
    const items: EntityListEntry[] = [];
    let exhausted = false;
    while (items.length < limit && !exhausted) {
      const amount = scanLimit(limit - items.length);
      const result = await this.#db
        .prepare(
          `SELECT entity_id, entity_type FROM taproot_entities
           WHERE (? IS NULL OR entity_type > ? OR
             (entity_type = ? AND CAST(substr(entity_id, 2) AS INTEGER) > ?))
             AND (? IS NULL OR entity_type = ?)
             AND (? = 1 OR deleted_at IS NULL)
           ORDER BY entity_type, CAST(substr(entity_id, 2) AS INTEGER) LIMIT ?`,
        )
        .bind(
          position?.entityType ?? null,
          position?.entityType ?? null,
          position?.entityType ?? null,
          position?.numericId ?? 0,
          filter.type,
          filter.type,
          filter.includeDeleted ? 1 : 0,
          amount,
        )
        .all<{ entity_id: EntityId; entity_type: EntityType }>();
      exhausted = result.results.length < amount;
      for (let index = 0; index < result.results.length; index += 1) {
        const candidate = result.results[index]!;
        position = {
          entityType: candidate.entity_type,
          numericId: Number(candidate.entity_id.slice(1)),
        };
        try {
          const stored = await this.#authorizedHydration(
            candidate.entity_id,
            undefined,
            () => this.#repository.getEntity(candidate.entity_id),
          );
          items.push({ entityId: candidate.entity_id, ...stored });
        } catch (error) {
          if (!(error instanceof AuthorizationDeniedError)) throw error;
        }
        if (items.length === limit) {
          if (index < result.results.length - 1) exhausted = false;
          break;
        }
      }
      if (!result.results.length) exhausted = true;
    }
    await this.#reauthorize(items.map((item) => item.entityId));
    await this.#assertGeneration(generation);
    return {
      items,
      cursor:
        !exhausted && position
          ? await this.#encodeCursor(binding, generation, position)
          : null,
    };
  }

  async searchEntities(
    query: string,
    options: AuthorizedSearchOptions = {},
  ): Promise<Page<SearchResult>> {
    const limit = authorizedLimit(options.limit, 20);
    const filter = {
      query,
      language: options.language ?? null,
      includeDeleted: options.includeDeleted ?? false,
    };
    const binding = await this.#binding('term-search', filter);
    const generation = await this.#generation();
    let offset = 0;
    if (options.cursor) {
      const cursor = await this.#decodeCursor(
        options.cursor,
        binding,
        generation,
      );
      offset = cursorNumber(cursor.position, 'offset');
    }
    await this.#assertContextCurrent();
    const escaped = query.replace(/[\\%_]/gu, '\\$&');
    const items: SearchResult[] = [];
    let exhausted = false;
    while (items.length < limit && !exhausted) {
      const amount = scanLimit(limit - items.length);
      const candidates = await this.#db
        .prepare(
          `SELECT t.entity_id
           FROM taproot_terms t JOIN taproot_entities e ON e.entity_id = t.entity_id
           WHERE t.value LIKE ? ESCAPE '\\' COLLATE NOCASE
             AND (? IS NULL OR t.language = ?)
             AND (? = 1 OR e.deleted_at IS NULL)
           ORDER BY CASE WHEN t.value = ? COLLATE NOCASE THEN 0 ELSE 1 END,
             t.value COLLATE NOCASE, t.entity_id, t.language, t.term_type, t.ordinal
           LIMIT ? OFFSET ?`,
        )
        .bind(
          `%${escaped}%`,
          filter.language,
          filter.language,
          filter.includeDeleted ? 1 : 0,
          query,
          amount,
          offset,
        )
        .all<{ entity_id: EntityId }>();
      exhausted = candidates.results.length < amount;
      const batchOffset = offset;
      for (let index = 0; index < candidates.results.length; index += 1) {
        const candidate = candidates.results[index]!;
        const candidateOffset = batchOffset + index;
        try {
          const before = await this.#readAndAuthorize(candidate.entity_id);
          const hydrated = await this.#db
            .prepare(
              `SELECT t.entity_id, e.entity_type, t.language, t.term_type, t.value
               FROM taproot_terms t JOIN taproot_entities e ON e.entity_id = t.entity_id
               WHERE t.value LIKE ? ESCAPE '\\' COLLATE NOCASE
                 AND (? IS NULL OR t.language = ?)
                 AND (? = 1 OR e.deleted_at IS NULL)
               ORDER BY CASE WHEN t.value = ? COLLATE NOCASE THEN 0 ELSE 1 END,
                 t.value COLLATE NOCASE, t.entity_id, t.language, t.term_type, t.ordinal
               LIMIT 1 OFFSET ?`,
            )
            .bind(
              `%${escaped}%`,
              filter.language,
              filter.language,
              filter.includeDeleted ? 1 : 0,
              query,
              candidateOffset,
            )
            .all<{
              entity_id: EntityId;
              entity_type: EntityType;
              language: string;
              term_type: SearchResult['termType'];
              value: string;
            }>();
          const row = hydrated.results[0];
          if (!row || row.entity_id !== candidate.entity_id)
            throw new AuthorizationDeniedError('Authorization denied');
          const after = await this.#readAndAuthorize(candidate.entity_id);
          if (
            before.state.authorizationRevision !==
              after.state.authorizationRevision ||
            before.record.authorizationRevision !==
              after.record.authorizationRevision ||
            serializeVisibilityScope(before.record.visibility) !==
              serializeVisibilityScope(after.record.visibility)
          )
            throw new AuthorizationDeniedError('Authorization denied');
          items.push({
            entityId: row.entity_id,
            entityType: row.entity_type,
            language: row.language,
            termType: row.term_type,
            value: row.value,
          });
        } catch (error) {
          if (!(error instanceof AuthorizationDeniedError)) throw error;
        }
        offset = candidateOffset + 1;
        if (items.length === limit) {
          if (index < candidates.results.length - 1) exhausted = false;
          break;
        }
      }
      if (!candidates.results.length) exhausted = true;
    }
    await this.#reauthorize(items.map((item) => item.entityId));
    await this.#assertGeneration(generation);
    return {
      items,
      cursor:
        !exhausted && items.length
          ? await this.#encodeCursor(binding, generation, { offset })
          : null,
    };
  }

  async getAuditEvent(eventId: string): Promise<AuditEvent> {
    const candidate = await this.#db
      .prepare(
        `SELECT entity_id, revision FROM taproot_audit_events WHERE event_id = ?`,
      )
      .bind(eventId)
      .all<{ entity_id: EntityId; revision: number }>();
    const row = candidate.results[0];
    if (!row) throw new AuthorizationDeniedError('Authorization denied');
    return this.#authorizedHydration(row.entity_id, row.revision, () =>
      this.#repository.getAuditEvent(eventId),
    );
  }

  async listAuditEvents(
    options: AuthorizedListAuditOptions = {},
  ): Promise<Page<AuditEvent>> {
    const limit = authorizedLimit(options.limit, 50);
    const filter = {
      entityId: options.entityId ?? null,
      requestId: options.requestId ?? null,
      type: options.type ?? null,
      attributionId: options.attributionId ?? null,
      tag: options.tag ?? null,
    };
    const binding = await this.#binding('audit-events', filter);
    const generation = await this.#generation();
    let before = Number.MAX_SAFE_INTEGER;
    if (options.cursor) {
      const cursor = await this.#decodeCursor(
        options.cursor,
        binding,
        generation,
      );
      before = cursorNumber(cursor.position, 'sequence');
    }
    await this.#assertContextCurrent();
    const items: AuditEvent[] = [];
    let exhausted = false;
    while (items.length < limit && !exhausted) {
      const amount = scanLimit(limit - items.length);
      const candidates = await this.#db
        .prepare(
          `SELECT rowid AS sequence, event_id, entity_id, revision FROM taproot_audit_events
           WHERE (? IS NULL OR entity_id = ?) AND (? IS NULL OR request_id = ?)
             AND (? IS NULL OR event_type = ?)
             AND (? IS NULL OR json_extract(attribution_json, '$.id') = ?)
             AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(tags_json) WHERE value = ?))
             AND rowid < ? ORDER BY rowid DESC LIMIT ?`,
        )
        .bind(
          filter.entityId,
          filter.entityId,
          filter.requestId,
          filter.requestId,
          filter.type,
          filter.type,
          filter.attributionId,
          filter.attributionId,
          filter.tag,
          filter.tag,
          before,
          amount,
        )
        .all<{
          sequence: number;
          event_id: string;
          entity_id: EntityId;
          revision: number;
        }>();
      exhausted = candidates.results.length < amount;
      for (let index = 0; index < candidates.results.length; index += 1) {
        const candidate = candidates.results[index]!;
        before = candidate.sequence;
        try {
          items.push(
            await this.#authorizedHydration(
              candidate.entity_id,
              candidate.revision,
              () => this.#repository.getAuditEvent(candidate.event_id),
            ),
          );
        } catch (error) {
          if (!(error instanceof AuthorizationDeniedError)) throw error;
        }
        if (items.length === limit) {
          if (index < candidates.results.length - 1) exhausted = false;
          break;
        }
      }
      if (!candidates.results.length) exhausted = true;
    }
    await this.#reauthorize(items.map((item) => item.entityId));
    await this.#assertGeneration(generation);
    return {
      items,
      cursor:
        !exhausted && items.length
          ? await this.#encodeCursor(binding, generation, { sequence: before })
          : null,
    };
  }

  async exportEntities(
    options: Omit<AuthorizedListEntitiesOptions, 'cursor' | 'limit'> = {},
  ): Promise<string> {
    const lines: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listEntities({
        ...options,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.items) lines.push(exportEntityJson(item.entity));
      cursor = page.cursor ?? undefined;
    } while (cursor);
    return lines.length ? `${lines.join('\n')}\n` : '';
  }

  async inspectEntityIntegrity(id: EntityId): Promise<EntityIntegrityReport> {
    requireSearchAdministration(this.#context);
    return this.#authorizedHydration(id, undefined, () =>
      this.#repository.inspectEntityIntegrity(id),
    );
  }

  async inspectTaprootIntegrity(
    options: AuthorizedListEntitiesOptions = {},
  ): Promise<Page<EntityIntegrityReport>> {
    requireSearchAdministration(this.#context);
    const entities = await this.listEntities({
      ...options,
      includeDeleted: true,
    });
    const items: EntityIntegrityReport[] = [];
    for (const entity of entities.items)
      items.push(await this.inspectEntityIntegrity(entity.entityId));
    return { items, cursor: entities.cursor };
  }

  async verifyAuditChain(id: EntityId): Promise<EntityIntegrityReport> {
    requireSearchAdministration(this.#context);
    return this.#authorizedHydration(id, undefined, async () => {
      const generation = await this.#generation();
      const revisions = await this.#db
        .prepare(
          `SELECT revision FROM taproot_entity_revisions
           WHERE entity_id = ? ORDER BY revision`,
        )
        .bind(id)
        .all<{ revision: number }>();
      const before = [];
      for (const { revision } of revisions.results)
        before.push(await this.#readAndAuthorize(id, revision));
      const report = await this.#repository.verifyAuditChain(id);
      for (let index = 0; index < revisions.results.length; index += 1) {
        const after = await this.#readAndAuthorize(
          id,
          revisions.results[index]!.revision,
        );
        const prior = before[index]!;
        if (
          prior.state.authorizationRevision !==
            after.state.authorizationRevision ||
          prior.record.authorizationRevision !==
            after.record.authorizationRevision ||
          serializeVisibilityScope(prior.record.visibility) !==
            serializeVisibilityScope(after.record.visibility)
        )
          throw new AuthorizationDeniedError('Authorization denied');
      }
      await this.#assertGeneration(generation);
      return report;
    });
  }

  async repairEntityProjection(
    id: EntityId,
    metadata: EditMetadata = {},
  ): Promise<EntityIntegrityReport> {
    requireSearchAdministration(this.#context);
    return this.#authorizedHydration(id, undefined, () =>
      this.#repository.repairEntityProjection(id, metadata),
    );
  }

  async #binding(operation: string, filter: unknown): Promise<string> {
    return fingerprintValue({
      operation,
      filter,
      installationId: this.#context.installationId,
      principalId: this.#context.principalId,
      activeWorkspaceId: this.#context.activeWorkspaceId,
      workspaceIds: this.#context.workspaceIds,
      capabilities: this.#context.capabilities,
      authorizationRevision: this.#context.authorizationRevision,
    });
  }

  async #generation(): Promise<string> {
    const result = await this.#db
      .prepare(
        `SELECT
           COALESCE((SELECT MAX(rowid) FROM taproot_entity_revisions), 0) AS revision_generation,
           COALESCE((SELECT MAX(rowid) FROM taproot_audit_events), 0) AS audit_generation`,
      )
      .all<{ revision_generation: number; audit_generation: number }>();
    const revisionGeneration = Number(
      result.results[0]?.revision_generation ?? 0,
    );
    const auditGeneration = Number(result.results[0]?.audit_generation ?? 0);
    if (
      !Number.isSafeInteger(revisionGeneration) ||
      revisionGeneration < 0 ||
      !Number.isSafeInteger(auditGeneration) ||
      auditGeneration < 0
    )
      throw new AuthorizationDeniedError('Authorization denied');
    return `${revisionGeneration}:${auditGeneration}`;
  }

  async #assertGeneration(expected: string): Promise<void> {
    if ((await this.#generation()) !== expected)
      throw new AuthorizationDeniedError('Authorization denied');
  }

  async #assertContextCurrent(): Promise<void> {
    try {
      const state = normalizeInstallationState(
        await this.#authorization.getInstallationAuthorizationState(),
      );
      if (
        state.installationId !== this.#context.installationId ||
        state.authorizationRevision !== this.#context.authorizationRevision
      )
        throw new AuthorizationDeniedError('Authorization denied');
    } catch {
      throw new AuthorizationDeniedError('Authorization denied');
    }
  }

  async #reauthorize(entityIds: readonly EntityId[]): Promise<void> {
    await this.#assertContextCurrent();
    for (const entityId of new Set(entityIds))
      await this.#readAndAuthorize(entityId);
  }

  async #encodeCursor(
    binding: string,
    generation: string,
    position: unknown,
  ): Promise<string> {
    const key = cursorCodecs.get(this.#cursorCodec)!;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const serialized = new TextEncoder().encode(
      JSON.stringify({ version: 1, binding, generation, position }),
    );
    if (serialized.length > CURSOR_PLAINTEXT_BYTES)
      throw new AuthorizationDeniedError('Authorization denied');
    const plaintext = new Uint8Array(CURSOR_PLAINTEXT_BYTES);
    plaintext.fill(0x20);
    plaintext.set(serialized);
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: CURSOR_AAD },
      key,
      plaintext,
    );
    return `${base64Url(iv)}.${base64Url(new Uint8Array(encrypted))}`;
  }

  async #decodeCursor(
    encoded: string,
    binding: string,
    generation: string,
  ): Promise<AuthorizationCursorPayload> {
    try {
      if (encoded.length > 4096) throw new Error('invalid cursor');
      const parts = encoded.split('.');
      if (parts.length !== 2) throw new Error('invalid cursor');
      const key = cursorCodecs.get(this.#cursorCodec)!;
      const decrypted = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: fromBase64Url(parts[0]!).buffer as ArrayBuffer,
          additionalData: CURSOR_AAD,
        },
        key,
        fromBase64Url(parts[1]!).buffer as ArrayBuffer,
      );
      const payload = JSON.parse(
        new TextDecoder().decode(decrypted),
      ) as unknown;
      if (
        !isRecord(payload) ||
        payload.version !== 1 ||
        payload.binding !== binding ||
        payload.generation !== generation ||
        !Object.hasOwn(payload, 'position') ||
        Object.keys(payload).length !== 4
      )
        throw new Error('invalid cursor');
      return payload as unknown as AuthorizationCursorPayload;
    } catch {
      throw new InvalidCursorError('Cursor is invalid');
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
        this.#authorization.getEntityAuthorization(entityId),
      ]);
      const normalizedState = normalizeInstallationState(state);
      const current = normalizeAuthorizationRecord(record);
      if (
        normalizedState.installationId !== this.#context.installationId ||
        current.installationId !== this.#context.installationId ||
        normalizedState.authorizationRevision !==
          this.#context.authorizationRevision ||
        current.authorizationRevision > normalizedState.authorizationRevision ||
        !isVisibleTo(current.visibility, this.#context)
      )
        throw new AuthorizationDeniedError('Authorization denied');
      let effective = current;
      if (revisionNumber !== undefined) {
        const historical = normalizeAuthorizationRecord(
          await this.#authorization.getEntityRevisionAuthorization(
            entityId,
            revisionNumber,
          ),
        );
        if (historical.installationId !== current.installationId)
          throw new AuthorizationDeniedError('Authorization denied');
        effective = {
          ...current,
          authorizationRevision: Math.max(
            current.authorizationRevision,
            historical.authorizationRevision,
          ),
          visibility: intersectVisibilityScopes(
            current.visibility,
            historical.visibility,
          ),
        };
      }
      if (
        effective.authorizationRevision >
          normalizedState.authorizationRevision ||
        !isVisibleTo(effective.visibility, this.#context)
      )
        throw new AuthorizationDeniedError('Authorization denied');
      return { state: normalizedState, record: effective };
    } catch {
      throw new AuthorizationDeniedError('Authorization denied');
    }
  }
}

export function createAuthorizedTaproot(
  db: SqliteDatabaseLike,
  options: TaprootOptions,
  context: AuthorizationContext,
  authorization: EntityAuthorizationSource,
  authorizedOptions: AuthorizedTaprootOptions,
): AuthorizedTaprootReader {
  return new AuthorizedTaprootReader(
    db,
    options,
    context,
    authorization,
    authorizedOptions,
  );
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
  value: CanonicalAuthorizationRecord | null,
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
  const normalized: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid(`${field} must be dense`);
    normalized.push(identifier(value[index], field));
  }
  return [...new Set(normalized)].sort(compareCodeUnits);
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

function authorizedLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new RangeError('limit must be an integer from 1 through 500');
  return limit;
}

function scanLimit(remaining: number): number {
  return Math.min(500, Math.max(32, remaining * 4));
}

function cursorNumber(position: unknown, key: string): number {
  if (
    !isRecord(position) ||
    Object.keys(position).length !== 1 ||
    !Object.hasOwn(position, key)
  )
    throw new InvalidCursorError('Cursor is invalid');
  const value = position[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new InvalidCursorError('Cursor is invalid');
  return value as number;
}

function entityPosition(position: unknown): EntityPosition {
  if (!isRecord(position)) throw new InvalidCursorError('Cursor is invalid');
  exactKeys(position, ['entityType', 'numericId']);
  if (
    (position.entityType !== 'item' && position.entityType !== 'property') ||
    !Number.isSafeInteger(position.numericId) ||
    (position.numericId as number) < 0
  )
    throw new InvalidCursorError('Cursor is invalid');
  return {
    entityType: position.entityType,
    numericId: position.numericId as number,
  };
}

async function fingerprintValue(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('invalid base64url');
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(
    value.replaceAll('-', '+').replaceAll('_', '/') + padding,
  );
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64Url(bytes) !== value) throw new Error('invalid base64url');
  return bytes;
}

function invalid(message: string): never {
  throw new InvalidAuthorizationError(message);
}
