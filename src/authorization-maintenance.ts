import type {
  SqliteDatabaseLike,
  SqlitePreparedStatementLike,
} from '@gnolith/diamond';
import {
  intersectVisibilityScopes,
  normalizeAuthorizationContext,
  normalizeCanonicalAuthorizationPolicy,
  requireSearchAdministration,
  serializeVisibilityScope,
} from './authorization.js';
import {
  AuthorizationDeniedError,
  InvalidAuthorizationError,
  RevisionConflictError,
} from './errors.js';
import type {
  EntityId,
  VisibilityScopeV1,
  WikibaseEntity,
  AuthorizationContext,
} from './types.js';
import { parseEntityJson } from './canonical.js';

const MAX_READINESS_PAGE = 100;
const MAX_BACKFILL_ENTITIES = 100;
const MAX_BACKFILL_REVISIONS = 2_000;

export type AuthorizationReadinessCode =
  | 'missing-current-policy'
  | 'current-revision-mismatch'
  | 'cross-installation-policy'
  | 'authorization-revision-invalid'
  | 'missing-revision-policy'
  | 'statement-policy-mismatch';

export interface AuthorizationReadinessIssue {
  entityId: EntityId;
  currentRevision: number;
  codes: AuthorizationReadinessCode[];
}

export interface AuthorizationReadinessInspection {
  installationId: string;
  authorizationRevision: number;
  searchGeneration: number;
  counts: {
    canonicalEntities: number;
    canonicalRevisions: number;
    currentPolicies: number;
    revisionPolicies: number;
    quarantinedEntities: number;
  };
  ready: boolean;
  issues: AuthorizationReadinessIssue[];
  cursor: EntityId | null;
}

export interface AuthorizationBackfillRevisionInput {
  revision: number;
  contentHash: string;
  workspaceId: string | null;
  ownerPrincipalId: string;
  visibility: VisibilityScopeV1;
  statementRestrictions: Readonly<Record<string, readonly VisibilityScopeV1[]>>;
}

export interface AuthorizationBackfillEntityInput {
  entityId: EntityId;
  revisions: readonly AuthorizationBackfillRevisionInput[];
}

export interface AuthorizationBackfillPlan {
  planId: string;
  installationId: string;
  baseAuthorizationRevision: number;
  manifestHash: string;
  entityCount: number;
  revisionCount: number;
  status: 'planned' | 'complete';
}

interface InstallationRow {
  installation_id: string;
  authorization_revision: number;
  search_generation: number;
  last_advance_id: string;
}

interface ManifestRevision {
  revision: number;
  contentHash: string;
  eventId: string;
  deletedAt: string | null;
  workspaceId: string | null;
  ownerPrincipalId: string;
  visibilityJson: string;
  effectiveVisibilityJson: string;
  statements: Array<{
    statementId: string;
    restrictionsJson: string;
    effectiveVisibilityJson: string;
  }>;
}

interface ManifestEntity {
  entityId: EntityId;
  revisions: ManifestRevision[];
}

interface Manifest {
  version: 1;
  installationId: string;
  entities: ManifestEntity[];
}

export async function inspectAuthorizationReadiness(
  db: SqliteDatabaseLike,
  rawContext: AuthorizationContext,
  options: { limit?: number; cursor?: EntityId } = {},
): Promise<AuthorizationReadinessInspection> {
  const { context, state } = await currentAdmin(db, rawContext);
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READINESS_PAGE)
    throw new RangeError(`limit must be from 1 through ${MAX_READINESS_PAGE}`);
  const cursor = options.cursor ?? '';
  if (typeof cursor !== 'string' || cursor.length > 32)
    throw new InvalidAuthorizationError('Readiness cursor is invalid');
  const counts = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM taproot_entities) AS canonical_entities,
        (SELECT COUNT(*) FROM taproot_entity_revisions) AS canonical_revisions,
        (SELECT COUNT(*) FROM taproot_entity_authorization) AS current_policies,
        (SELECT COUNT(*) FROM taproot_entity_authorization_revisions) AS revision_policies,
        (SELECT COUNT(*) FROM taproot_entities e
         WHERE NOT EXISTS (
           SELECT 1 FROM taproot_entity_authorization p
           WHERE p.entity_id = e.entity_id AND p.source_revision = e.revision
             AND p.installation_id = ?
             AND p.authorization_revision <= ?
         )) AS quarantined_entities`,
    )
    .bind(context.installationId, context.authorizationRevision)
    .all<{
      canonical_entities: number;
      canonical_revisions: number;
      current_policies: number;
      revision_policies: number;
      quarantined_entities: number;
    }>();
  const count = counts.results[0]!;
  const page = await db
    .prepare(
      `SELECT entity_id, revision FROM taproot_entities
       WHERE entity_id > ? ORDER BY entity_id LIMIT ?`,
    )
    .bind(cursor, limit + 1)
    .all<{ entity_id: EntityId; revision: number }>();
  const issues: AuthorizationReadinessIssue[] = [];
  for (const row of page.results.slice(0, limit)) {
    const codes = await readinessCodes(db, row.entity_id, row.revision, state);
    if (codes.length)
      issues.push({
        entityId: row.entity_id,
        currentRevision: Number(row.revision),
        codes,
      });
  }
  return {
    installationId: state.installation_id,
    authorizationRevision: Number(state.authorization_revision),
    searchGeneration: Number(state.search_generation),
    counts: {
      canonicalEntities: Number(count.canonical_entities),
      canonicalRevisions: Number(count.canonical_revisions),
      currentPolicies: Number(count.current_policies),
      revisionPolicies: Number(count.revision_policies),
      quarantinedEntities: Number(count.quarantined_entities),
    },
    ready:
      Number(count.quarantined_entities) === 0 &&
      Number(count.canonical_revisions) === Number(count.revision_policies),
    issues,
    cursor:
      page.results.length > limit
        ? (page.results[limit - 1]?.entity_id ?? null)
        : null,
  };
}

export async function planAuthorizationBackfill(
  db: SqliteDatabaseLike,
  rawContext: AuthorizationContext,
  inputs: readonly AuthorizationBackfillEntityInput[],
  now: string = new Date().toISOString(),
): Promise<AuthorizationBackfillPlan> {
  const { context } = await currentAdmin(db, rawContext);
  if (
    !isArrayValue(inputs) ||
    inputs.length < 1 ||
    inputs.length > MAX_BACKFILL_ENTITIES
  )
    throw new InvalidAuthorizationError(
      `A backfill plan must contain 1 through ${MAX_BACKFILL_ENTITIES} entities`,
    );
  const ids = inputs.map(({ entityId }) => entityId);
  if (new Set(ids).size !== ids.length)
    throw new InvalidAuthorizationError('Backfill entity IDs must be unique');
  const manifestEntities: ManifestEntity[] = [];
  let revisionCount = 0;
  for (const input of [...inputs].sort((a, b) =>
    compareCodeUnits(a.entityId, b.entityId),
  )) {
    const existing = await db
      .prepare(
        `SELECT 1 AS found FROM taproot_entity_authorization WHERE entity_id = ?`,
      )
      .bind(input.entityId)
      .all<{ found: number }>();
    if (existing.results.length)
      throw new RevisionConflictError(
        `Entity ${input.entityId} already has canonical policy`,
      );
    const canonical = await db
      .prepare(
        `SELECT revision, entity_json, content_hash, event_id, deleted_at
         FROM taproot_entity_revisions WHERE entity_id = ? ORDER BY revision`,
      )
      .bind(input.entityId)
      .all<{
        revision: number;
        entity_json: string;
        content_hash: string;
        event_id: string;
        deleted_at: string | null;
      }>();
    const supplied = [...input.revisions].sort(
      (a, b) => a.revision - b.revision,
    );
    if (
      canonical.results.length === 0 ||
      canonical.results.length !== supplied.length
    )
      throw new RevisionConflictError(
        `Backfill must explicitly cover every revision of ${input.entityId}`,
      );
    revisionCount += supplied.length;
    if (revisionCount > MAX_BACKFILL_REVISIONS)
      throw new InvalidAuthorizationError(
        `A backfill plan may contain at most ${MAX_BACKFILL_REVISIONS} revisions`,
      );
    const revisions: ManifestRevision[] = [];
    for (let index = 0; index < canonical.results.length; index += 1) {
      const row = canonical.results[index]!;
      const suppliedRevision = supplied[index]!;
      if (
        Number(row.revision) !== suppliedRevision.revision ||
        row.content_hash !== suppliedRevision.contentHash
      )
        throw new RevisionConflictError(
          `Backfill revision/hash attestation failed for ${input.entityId}`,
        );
      const entity = parseEntityJson(row.entity_json);
      const normalized = normalizeCanonicalAuthorizationPolicy({
        installationId: context.installationId,
        workspaceId: suppliedRevision.workspaceId,
        ownerPrincipalId: suppliedRevision.ownerPrincipalId,
        visibility: suppliedRevision.visibility,
        statementRestrictions: suppliedRevision.statementRestrictions,
        expectedAuthorizationRevision: context.authorizationRevision,
      });
      const expectedIds = statementIds(entity);
      const providedIds = Object.keys(normalized.statementRestrictions).sort(
        compareCodeUnits,
      );
      if (JSON.stringify(expectedIds) !== JSON.stringify(providedIds))
        throw new InvalidAuthorizationError(
          `Backfill statement restrictions do not exactly cover ${input.entityId}@${row.revision}`,
        );
      const statements = expectedIds.map((statementId) => {
        const restrictions = normalized.statementRestrictions[statementId]!;
        return {
          statementId,
          restrictionsJson: JSON.stringify(restrictions),
          effectiveVisibilityJson: serializeVisibilityScope(
            intersectVisibilityScopes(normalized.visibility, ...restrictions),
          ),
        };
      });
      const effectiveVisibilityJson = serializeVisibilityScope(
        intersectVisibilityScopes(
          normalized.visibility,
          ...statements.map(
            ({ effectiveVisibilityJson }) =>
              JSON.parse(effectiveVisibilityJson) as VisibilityScopeV1,
          ),
        ),
      );
      revisions.push({
        revision: Number(row.revision),
        contentHash: row.content_hash,
        eventId: row.event_id,
        deletedAt: row.deleted_at,
        workspaceId: normalized.workspaceId,
        ownerPrincipalId: normalized.ownerPrincipalId,
        visibilityJson: serializeVisibilityScope(normalized.visibility),
        effectiveVisibilityJson,
        statements,
      });
    }
    manifestEntities.push({ entityId: input.entityId, revisions });
  }
  const manifest: Manifest = {
    version: 1,
    installationId: context.installationId,
    entities: manifestEntities,
  };
  const manifestJson = JSON.stringify(manifest);
  const manifestHash = await sha256(manifestJson);
  const planId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        `INSERT INTO taproot_authorization_backfill_plans(
           plan_id, installation_id, base_authorization_revision,
           manifest_json, manifest_hash, entity_count, revision_count,
           status, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`,
      )
      .bind(
        planId,
        context.installationId,
        context.authorizationRevision,
        manifestJson,
        manifestHash,
        manifestEntities.length,
        revisionCount,
        context.principalId,
        now,
      ),
    db
      .prepare(
        `INSERT INTO taproot_authorization_admin_audit(
           audit_id, event_type, principal_id, plan_id,
           authorization_revision, details_json, created_at
         ) VALUES (?, 'backfill-plan', ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        context.principalId,
        planId,
        context.authorizationRevision,
        JSON.stringify({
          manifestHash,
          entityCount: manifestEntities.length,
          revisionCount,
        }),
        now,
      ),
  ]);
  return {
    planId,
    installationId: context.installationId,
    baseAuthorizationRevision: context.authorizationRevision,
    manifestHash,
    entityCount: manifestEntities.length,
    revisionCount,
    status: 'planned',
  };
}

export async function applyAuthorizationBackfill(
  db: SqliteDatabaseLike,
  rawContext: AuthorizationContext,
  planId: string,
  now: string = new Date().toISOString(),
): Promise<AuthorizationBackfillPlan> {
  const { context, state } = await currentAdmin(db, rawContext);
  const plan = await db
    .prepare(
      `SELECT installation_id, base_authorization_revision, manifest_json,
              manifest_hash, entity_count, revision_count, status
       FROM taproot_authorization_backfill_plans WHERE plan_id = ?`,
    )
    .bind(planId)
    .all<{
      installation_id: string;
      base_authorization_revision: number;
      manifest_json: string;
      manifest_hash: string;
      entity_count: number;
      revision_count: number;
      status: 'planned' | 'complete';
    }>();
  const row = plan.results[0];
  if (!row) throw new InvalidAuthorizationError('Backfill plan was not found');
  if (row.status === 'complete') return planResult(planId, row);
  if (
    row.installation_id !== context.installationId ||
    Number(row.base_authorization_revision) !== context.authorizationRevision ||
    (await sha256(row.manifest_json)) !== row.manifest_hash
  )
    throw new RevisionConflictError('Backfill plan is stale or corrupted');
  const manifest = JSON.parse(row.manifest_json) as Manifest;
  if (
    manifest.version !== 1 ||
    manifest.installationId !== context.installationId ||
    manifest.entities.length !== Number(row.entity_count)
  )
    throw new RevisionConflictError('Backfill manifest is invalid');

  const entityCurrent: unknown[] = [];
  const entityHistory: unknown[] = [];
  const statementCurrent: unknown[] = [];
  const statementHistory: unknown[] = [];
  const outbox: unknown[] = [];
  const newAuthorizationRevision = context.authorizationRevision + 1;
  const newSearchGeneration = Number(state.search_generation) + 1;
  for (const entity of manifest.entities) {
    const current = entity.revisions.at(-1)!;
    entityCurrent.push({ entityId: entity.entityId, ...current });
    for (const revision of entity.revisions) {
      entityHistory.push({ entityId: entity.entityId, ...revision });
      for (const statement of revision.statements)
        statementHistory.push({
          entityId: entity.entityId,
          revision: revision.revision,
          ...statement,
        });
    }
    for (const statement of current.statements)
      statementCurrent.push({
        entityId: entity.entityId,
        revision: current.revision,
        ...statement,
      });
    outbox.push({
      eventId: current.eventId,
      entityId: entity.entityId,
      revision: current.revision,
      operation: current.deletedAt ? 'delete' : 'backfill',
    });
  }

  const statements: SqlitePreparedStatementLike[] = [
    db
      .prepare(
        `UPDATE taproot_installation_authorization
         SET authorization_revision = ?, search_generation = ?, last_advance_id = ?, updated_at = ?
         WHERE singleton = 1 AND installation_id = ?
           AND authorization_revision = ? AND search_generation = ?`,
      )
      .bind(
        newAuthorizationRevision,
        newSearchGeneration,
        planId,
        now,
        context.installationId,
        context.authorizationRevision,
        state.search_generation,
      ),
    assertion(
      db,
      `EXISTS (SELECT 1 FROM taproot_installation_authorization
       WHERE singleton = 1 AND installation_id = ?
         AND authorization_revision = ? AND search_generation = ?
         AND last_advance_id = ?)`,
      context.installationId,
      newAuthorizationRevision,
      newSearchGeneration,
      planId,
    ),
    assertion(
      db,
      `NOT EXISTS (
         SELECT 1 FROM taproot_entity_authorization
         WHERE entity_id IN (
           SELECT json_extract(value, '$.entityId') FROM json_each(?)
         )
       )`,
      JSON.stringify(entityCurrent),
    ),
    db
      .prepare(
        `INSERT INTO taproot_entity_authorization(
           entity_id, installation_id, workspace_id, owner_principal_id,
           visibility_json, effective_visibility_json, source_revision,
           authorization_revision, deleted_at, event_id, updated_at
         )
         SELECT json_extract(value, '$.entityId'), ?,
           json_extract(value, '$.workspaceId'),
           json_extract(value, '$.ownerPrincipalId'),
           json_extract(value, '$.visibilityJson'),
           json_extract(value, '$.effectiveVisibilityJson'),
           json_extract(value, '$.revision'), ?,
           json_extract(value, '$.deletedAt'), json_extract(value, '$.eventId'), ?
         FROM json_each(?)`,
      )
      .bind(
        context.installationId,
        newAuthorizationRevision,
        now,
        JSON.stringify(entityCurrent),
      ),
    db
      .prepare(
        `INSERT INTO taproot_entity_authorization_revisions(
           entity_id, source_revision, installation_id, workspace_id,
           owner_principal_id, visibility_json, effective_visibility_json,
           authorization_revision, deleted_at, event_id, created_at
         )
         SELECT json_extract(value, '$.entityId'), json_extract(value, '$.revision'), ?,
           json_extract(value, '$.workspaceId'),
           json_extract(value, '$.ownerPrincipalId'),
           json_extract(value, '$.visibilityJson'),
           json_extract(value, '$.effectiveVisibilityJson'), ?,
           json_extract(value, '$.deletedAt'), json_extract(value, '$.eventId'), ?
         FROM json_each(?)`,
      )
      .bind(
        context.installationId,
        newAuthorizationRevision,
        now,
        JSON.stringify(entityHistory),
      ),
    db
      .prepare(
        `INSERT INTO taproot_statement_authorization(
           entity_id, statement_id, source_revision, restrictions_json,
           effective_visibility_json, authorization_revision
         )
         SELECT json_extract(value, '$.entityId'),
           json_extract(value, '$.statementId'), json_extract(value, '$.revision'),
           json_extract(value, '$.restrictionsJson'),
           json_extract(value, '$.effectiveVisibilityJson'), ?
         FROM json_each(?)`,
      )
      .bind(newAuthorizationRevision, JSON.stringify(statementCurrent)),
    db
      .prepare(
        `INSERT INTO taproot_statement_authorization_revisions(
           entity_id, source_revision, statement_id, restrictions_json,
           effective_visibility_json, authorization_revision
         )
         SELECT json_extract(value, '$.entityId'), json_extract(value, '$.revision'),
           json_extract(value, '$.statementId'),
           json_extract(value, '$.restrictionsJson'),
           json_extract(value, '$.effectiveVisibilityJson'), ?
         FROM json_each(?)`,
      )
      .bind(newAuthorizationRevision, JSON.stringify(statementHistory)),
    db
      .prepare(
        `INSERT INTO taproot_authorization_projection_outbox(
           event_id, entity_id, source_revision, authorization_revision,
           search_generation, operation, created_at
         )
         SELECT json_extract(value, '$.eventId'), json_extract(value, '$.entityId'),
           json_extract(value, '$.revision'), ?, ?,
           json_extract(value, '$.operation'), ? FROM json_each(?)`,
      )
      .bind(
        newAuthorizationRevision,
        newSearchGeneration,
        now,
        JSON.stringify(outbox),
      ),
    db
      .prepare(
        `UPDATE taproot_authorization_backfill_plans
         SET status = 'complete', completed_at = ?
         WHERE plan_id = ? AND status = 'planned'
           AND base_authorization_revision = ?`,
      )
      .bind(now, planId, context.authorizationRevision),
    assertion(
      db,
      `EXISTS (SELECT 1 FROM taproot_authorization_backfill_plans
       WHERE plan_id = ? AND status = 'complete')`,
      planId,
    ),
    db
      .prepare(
        `INSERT INTO taproot_authorization_admin_audit(
           audit_id, event_type, principal_id, plan_id,
           authorization_revision, details_json, created_at
         ) VALUES (?, 'backfill-apply', ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        context.principalId,
        planId,
        newAuthorizationRevision,
        JSON.stringify({
          manifestHash: row.manifest_hash,
          entityCount: row.entity_count,
          revisionCount: row.revision_count,
        }),
        now,
      ),
  ];
  try {
    await db.batch(statements);
  } catch (cause) {
    throw new RevisionConflictError(
      'Backfill apply lost its canonical or authorization CAS',
      { cause: cause instanceof Error ? cause : undefined },
    );
  }
  return {
    ...planResult(planId, row),
    status: 'complete',
  };
}

async function currentAdmin(
  db: SqliteDatabaseLike,
  rawContext: AuthorizationContext,
): Promise<{ context: AuthorizationContext; state: InstallationRow }> {
  const context = normalizeAuthorizationContext(rawContext);
  requireSearchAdministration(context);
  const result = await db
    .prepare(
      `SELECT installation_id, authorization_revision, search_generation, last_advance_id
       FROM taproot_installation_authorization WHERE singleton = 1`,
    )
    .all<InstallationRow>();
  const state = result.results[0];
  if (
    !state ||
    state.installation_id !== context.installationId ||
    Number(state.authorization_revision) !== context.authorizationRevision
  )
    throw new AuthorizationDeniedError('Authorization denied');
  return { context, state };
}

async function readinessCodes(
  db: SqliteDatabaseLike,
  entityId: EntityId,
  currentRevision: number,
  state: InstallationRow,
): Promise<AuthorizationReadinessCode[]> {
  const codes: AuthorizationReadinessCode[] = [];
  const policy = await db
    .prepare(
      `SELECT installation_id, source_revision, authorization_revision
       FROM taproot_entity_authorization WHERE entity_id = ?`,
    )
    .bind(entityId)
    .all<{
      installation_id: string;
      source_revision: number;
      authorization_revision: number;
    }>();
  const current = policy.results[0];
  if (!current) codes.push('missing-current-policy');
  else {
    if (Number(current.source_revision) !== Number(currentRevision))
      codes.push('current-revision-mismatch');
    if (current.installation_id !== state.installation_id)
      codes.push('cross-installation-policy');
    if (
      Number(current.authorization_revision) < 1 ||
      Number(current.authorization_revision) >
        Number(state.authorization_revision)
    )
      codes.push('authorization-revision-invalid');
  }
  const missingHistory = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM taproot_entity_revisions r
       WHERE r.entity_id = ? AND NOT EXISTS (
         SELECT 1 FROM taproot_entity_authorization_revisions p
         WHERE p.entity_id = r.entity_id AND p.source_revision = r.revision
       )`,
    )
    .bind(entityId)
    .all<{ count: number }>();
  if (Number(missingHistory.results[0]?.count ?? 0) !== 0)
    codes.push('missing-revision-policy');
  const statementMismatch = await db
    .prepare(
      `WITH expected(entity_id, revision, statement_id) AS (
         SELECT r.entity_id, r.revision, json_extract(statement.value, '$.id')
         FROM taproot_entity_revisions r,
           json_each(r.entity_json, '$.claims') claim,
           json_each(claim.value) statement
         WHERE r.entity_id = ?
       )
       SELECT
         (SELECT COUNT(*) FROM expected e WHERE NOT EXISTS (
           SELECT 1 FROM taproot_statement_authorization_revisions p
           WHERE p.entity_id = e.entity_id AND p.source_revision = e.revision
             AND p.statement_id = e.statement_id
         )) +
         (SELECT COUNT(*) FROM taproot_statement_authorization_revisions p
          WHERE p.entity_id = ? AND NOT EXISTS (
            SELECT 1 FROM expected e
            WHERE e.entity_id = p.entity_id AND e.revision = p.source_revision
              AND e.statement_id = p.statement_id
          )) AS count`,
    )
    .bind(entityId, entityId)
    .all<{ count: number }>();
  if (Number(statementMismatch.results[0]?.count ?? 0) !== 0)
    codes.push('statement-policy-mismatch');
  return codes;
}

function assertion(
  db: SqliteDatabaseLike,
  condition: string,
  ...values: unknown[]
): SqlitePreparedStatementLike {
  return db
    .prepare(
      `INSERT INTO taproot_assertions(assertion_key)
       SELECT NULL WHERE NOT (${condition})`,
    )
    .bind(...values);
}

function planResult(
  planId: string,
  row: {
    installation_id: string;
    base_authorization_revision: number;
    manifest_hash: string;
    entity_count: number;
    revision_count: number;
    status: 'planned' | 'complete';
  },
): AuthorizationBackfillPlan {
  return {
    planId,
    installationId: row.installation_id,
    baseAuthorizationRevision: Number(row.base_authorization_revision),
    manifestHash: row.manifest_hash,
    entityCount: Number(row.entity_count),
    revisionCount: Number(row.revision_count),
    status: row.status,
  };
}

function statementIds(entity: WikibaseEntity): string[] {
  return Object.values(entity.claims)
    .flatMap((statements) => statements.map(({ id }) => id))
    .sort(compareCodeUnits);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isArrayValue(value: unknown): boolean {
  return Array.isArray(value);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
