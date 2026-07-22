import type {
  D1DatabaseLike,
  SqlitePreparedStatementLike,
  SqliteResultLike,
} from '@gnolith/diamond';
import {
  normalizeAuthorizationContext,
  normalizeVisibilityScope,
} from './authorization.js';
import { InvalidAuthorizationError } from './errors.js';
import {
  UNIFIED_SEARCH_LIMITS,
  canonicalSearchHashV1,
  deriveSearchContractIdV1,
  normalizeUnifiedSearchFiltersV1,
  type DerivedSearchChunkV1,
  type DerivedSearchDocumentV1,
  type SearchAuthorizationEnvelopeValueV1,
  type SearchProjectionPlanV1,
  type SearchProjectionSegmentV1,
  type SearchProjectionSourceEventV1,
  type UnifiedSearchFiltersV1,
  type UnifiedSearchReferenceV1,
} from './search-contract.js';
import {
  normalizeUnifiedSearchSourceEventInputV1,
  prepareUnifiedSearchSourceEventStatementsV1,
  readPersistedSearchSourceRegistryV1,
  type UnifiedSearchSourceKindV1,
  type UnifiedSearchSourcePredecessorV1,
} from './search-source-events.js';
import type { AuthorizationContext, VisibilityScopeV1 } from './types.js';

const MAX_DOMAIN_STATEMENTS = 100;
const MAX_SQL_BYTES = 64 * 1024;
const BLOCKED_SQL = /(?:^|[^a-z0-9_])(?:taproot_|_gnolith_)/iu;

export interface ExternalSearchDomainMutationBindingV1 {
  domain: string;
  sourceKind: 'task' | 'memory';
  capability: string;
  changeClasses: readonly string[];
}

export interface ExternalSearchDomainSqlV1 {
  sql: string;
  values: readonly unknown[];
}

export interface ExternalSearchCanonicalMutationInputV1 {
  context: AuthorizationContext;
  eventId: string;
  sourceId: string;
  operation: 'upsert' | 'delete';
  changeClass: string;
  sourceRevision: string;
  sourcePolicyRevision: number;
  predecessor: UnifiedSearchSourcePredecessorV1 | null;
  canonicalPostState: unknown;
  statements: readonly ExternalSearchDomainSqlV1[];
}

export interface OpaqueExternalSearchCanonicalMutationV1 {
  readonly kind: 'taproot-external-search-canonical-mutation-v1';
}

export interface ExternalSearchDomainMutationCoordinatorV1 {
  readonly kind: 'taproot-external-search-domain-mutation-coordinator-v1';
  sealCanonicalMutation(
    input: ExternalSearchCanonicalMutationInputV1,
  ): Promise<OpaqueExternalSearchCanonicalMutationV1>;
}

export interface ExternalSearchCanonicalMutationReceiptV1 {
  eventId: string;
  authorizationRevision: number;
  searchGeneration: number;
  results: readonly SqliteResultLike[];
}

export interface ExternalSearchProducerDescriptorV1 {
  version: 1;
  sourceKind: 'task' | 'memory';
  owningDomain: 'workshop';
  producerFingerprint: string;
  contractVersion: string;
  projectionVersion: string;
  authorizationContractVersion: string;
}

export interface ExternalSearchLoadedSourceV1 {
  sourceId: string;
  sourceRevision: string;
  sourcePolicyRevision: number;
  canonical: unknown;
}

export interface ExternalSearchProducerCallbacksV1 {
  enumerateLegacyCurrent(input: {
    cursor: string | null;
    limit: number;
  }): Promise<{ sourceIds: readonly string[]; nextCursor: string | null }>;
  loadCurrent(input: {
    sourceId: string;
    expectedSourceRevision: string | null;
  }): Promise<ExternalSearchLoadedSourceV1 | null>;
  projectCurrent(input: {
    source: ExternalSearchLoadedSourceV1;
    authorization: ExternalSearchAuthorizationV1;
  }): Promise<ExternalSearchProjectionInputV1>;
  authorizeCurrentReference(
    authority: ExternalSearchDomainPolicyAuthorityV1,
    input: {
      sourceId: string;
      sourceRevision: string;
      sourcePolicyRevision: number;
    },
  ): Promise<ExternalSearchAuthorizationV1>;
  hydrateCurrentReference(
    authority: ExternalSearchDomainPolicyAuthorityV1,
    input: {
      sourceId: string;
      sourceRevision: string;
      sourcePolicyRevision: number;
    },
  ): Promise<unknown>;
}

export interface ExternalSearchAuthorizationV1 {
  version: 1;
  sourceId: string;
  sourceRevision: string;
  sourcePolicyRevision: number;
  workspaceId: string | null;
  ownerPrincipalId: string;
  visibility: VisibilityScopeV1;
}

export interface ExternalSearchProjectionDocumentInputV1 {
  documentSlot: string;
  canonicalReference: UnifiedSearchReferenceV1;
  filterMetadata: UnifiedSearchFiltersV1;
  text: string;
  segments: readonly SearchProjectionSegmentV1[];
}

export interface ExternalSearchProjectionInputV1 {
  version: 1;
  documents: readonly ExternalSearchProjectionDocumentInputV1[];
  replaceAll: true;
  removeDocumentSlots: readonly string[];
}

export interface ExternalSearchDomainPolicyAuthorityV1 {
  readonly kind: 'taproot-external-search-domain-policy-authority-v1';
}

export interface ExternalSearchProducerGuardV1 {
  readonly kind: 'taproot-external-search-producer-guard-v1';
  commitCanonicalMutation(
    mutation: OpaqueExternalSearchCanonicalMutationV1,
  ): Promise<ExternalSearchCanonicalMutationReceiptV1>;
  adoptLegacyPage(
    context: AuthorizationContext,
    options: { limit: number },
  ): Promise<{
    enumerated: number;
    adopted: number;
    complete: boolean;
  }>;
}

export interface ExternalSearchProducerRuntimeV1 {
  readonly descriptor: Readonly<ExternalSearchProducerDescriptorV1>;
  readonly callbacks: ExternalSearchProducerCallbacksV1;
  readonly policyAuthority: ExternalSearchDomainPolicyAuthorityV1;
}

interface CoordinatorBinding {
  db: D1DatabaseLike;
  installationId: string;
  domain: string;
  sourceKind: 'task' | 'memory';
  capability: string;
  changeClasses: readonly string[];
  clock: () => Date;
  generation: object;
}

interface MutationBinding {
  coordinator: ExternalSearchDomainMutationCoordinatorV1;
  coordinatorGeneration: object;
  context: AuthorizationContext;
  event: {
    eventId: string;
    sourceId: string;
    operation: 'upsert' | 'delete';
    changeClass: string;
    sourceRevision: string;
    sourceHash: string;
    predecessor: UnifiedSearchSourcePredecessorV1 | null;
  };
  sourcePolicyRevision: number;
  statements: readonly SqlitePreparedStatementLike[];
  attempted: boolean;
}

const coordinatorBindings = new WeakMap<object, CoordinatorBinding>();
const mutationBindings = new WeakMap<object, MutationBinding>();
const policyAuthorityBindings = new WeakMap<
  object,
  Pick<CoordinatorBinding, 'db' | 'installationId' | 'domain' | 'sourceKind'>
>();
const producerRuntimes = new WeakMap<
  object,
  Map<string, ExternalSearchProducerRuntimeV1>
>();

/** @internal Host-capability validation is performed by the package entrypoint. */
export function createExternalSearchDomainPolicyAuthorityInternalV1(
  binding: Pick<
    CoordinatorBinding,
    'db' | 'installationId' | 'domain' | 'sourceKind'
  >,
): ExternalSearchDomainPolicyAuthorityV1 {
  if (binding.domain !== 'workshop')
    denied('policy authority domain is invalid');
  const authority: ExternalSearchDomainPolicyAuthorityV1 = Object.freeze({
    kind: 'taproot-external-search-domain-policy-authority-v1' as const,
  });
  policyAuthorityBindings.set(authority, { ...binding });
  return authority;
}

/** @internal Host-capability validation is performed by the package entrypoint. */
export async function createExternalSearchProducerGuardInternalV1(
  binding: {
    db: D1DatabaseLike;
    installationId: string;
    clock: () => Date;
  },
  rawDescriptor: ExternalSearchProducerDescriptorV1,
  callbacks: ExternalSearchProducerCallbacksV1,
  policyAuthority: ExternalSearchDomainPolicyAuthorityV1,
  coordinator: ExternalSearchDomainMutationCoordinatorV1,
): Promise<ExternalSearchProducerGuardV1> {
  const descriptor = normalizeProducerDescriptor(rawDescriptor);
  const policy = policyAuthorityBindings.get(policyAuthority);
  const mutation = coordinatorBindings.get(coordinator);
  if (
    !policy ||
    !mutation ||
    policy.db !== binding.db ||
    mutation.db !== binding.db ||
    policy.installationId !== binding.installationId ||
    mutation.installationId !== binding.installationId ||
    policy.domain !== descriptor.owningDomain ||
    mutation.domain !== descriptor.owningDomain ||
    policy.sourceKind !== descriptor.sourceKind ||
    mutation.sourceKind !== descriptor.sourceKind
  )
    denied('external producer binding mismatch');
  validateCallbacks(callbacks);
  await registerManifest(binding, descriptor);
  const runtime = Object.freeze({ descriptor, callbacks, policyAuthority });
  let runtimes = producerRuntimes.get(binding.db);
  if (!runtimes) {
    runtimes = new Map();
    producerRuntimes.set(binding.db, runtimes);
  }
  const key = runtimeKey(
    binding.installationId,
    descriptor.sourceKind,
    descriptor.producerFingerprint,
  );
  const existing = runtimes.get(key);
  if (existing && existing.callbacks !== callbacks)
    denied('conflicting external producer registration');
  runtimes.set(key, runtime);
  return Object.freeze({
    kind: 'taproot-external-search-producer-guard-v1' as const,
    commitCanonicalMutation: (
      opaqueMutation: OpaqueExternalSearchCanonicalMutationV1,
    ) =>
      commitExternalSearchCanonicalMutationInternalV1(
        coordinator,
        opaqueMutation,
      ),
    adoptLegacyPage: (
      context: AuthorizationContext,
      options: { limit: number },
    ) =>
      adoptLegacyPage(
        binding,
        descriptor,
        callbacks,
        policyAuthority,
        mutation,
        context,
        options,
      ),
  });
}

/** @internal Materialization uses this process-local lookup before claiming. */
export function lookupExternalSearchProducerRuntimeInternalV1(
  db: D1DatabaseLike,
  installationId: string,
  sourceKind: UnifiedSearchSourceKindV1,
  producerFingerprint: string | null,
): ExternalSearchProducerRuntimeV1 | null {
  if (!producerFingerprint) return null;
  return (
    producerRuntimes
      .get(db)
      ?.get(runtimeKey(installationId, sourceKind, producerFingerprint)) ?? null
  );
}

/** @internal Builds all IDs, hashes, chunks, and authority envelopes in Taproot. */
export async function buildExternalSearchProjectionPlanInternalV1(
  runtime: ExternalSearchProducerRuntimeV1,
  loaded: ExternalSearchLoadedSourceV1,
  source: SearchProjectionSourceEventV1,
  maxChunkBytes: number,
): Promise<SearchProjectionPlanV1> {
  validateLoadedSource(loaded, source.sourceId);
  if (
    loaded.sourceRevision !== source.sourceRevision ||
    loaded.sourcePolicyRevision !== source.sourcePolicyRevision ||
    (await canonicalSearchHashV1(loaded.canonical)) !== source.sourceHash
  )
    denied('external source does not match the persisted event');
  const rawAuthorization = await runtime.callbacks.authorizeCurrentReference(
    runtime.policyAuthority,
    {
      sourceId: loaded.sourceId,
      sourceRevision: loaded.sourceRevision,
      sourcePolicyRevision: loaded.sourcePolicyRevision,
    },
  );
  const authorization = await normalizeExternalAuthorization(
    rawAuthorization,
    source,
  );
  const rawPlan = await runtime.callbacks.projectCurrent({
    source: loaded,
    authorization: rawAuthorization,
  });
  exactKeys(rawPlan, [
    'documents',
    'removeDocumentSlots',
    'replaceAll',
    'version',
  ]);
  if (rawPlan.version !== 1 || rawPlan.replaceAll !== true)
    denied('external projection plan version is invalid');
  if (!Array.isArray(rawPlan.documents) || rawPlan.documents.length > 100)
    denied('external projection document limit exceeded');
  if (
    !Array.isArray(rawPlan.removeDocumentSlots) ||
    rawPlan.removeDocumentSlots.length > 100
  )
    denied('external projection removals are invalid');
  const removeDocumentSlots = rawPlan.removeDocumentSlots.map((value) =>
    token(value, 'removeDocumentSlot', 256),
  );
  const documents: DerivedSearchDocumentV1[] = [];
  const chunks: DerivedSearchChunkV1[] = [];
  const rawDocuments =
    rawPlan.documents as readonly ExternalSearchProjectionDocumentInputV1[];
  for (const rawDocument of rawDocuments) {
    const document = await buildExternalDocument(
      runtime.descriptor.sourceKind,
      source,
      authorization,
      rawDocument,
    );
    documents.push(document);
    chunks.push(...(await chunkExternalDocument(document, maxChunkBytes)));
  }
  if (
    new Set(documents.map(({ documentSlot }) => documentSlot)).size !==
    documents.length
  )
    denied('external projection document slots are not unique');
  const id = await deriveSearchContractIdV1('plan', {
    source,
    documentIds: documents.map(({ id: documentId }) => documentId),
    chunkIds: chunks.map(({ id: chunkId }) => chunkId),
    replaceAll: true,
    removeDocumentSlots,
  });
  const payload = {
    version: 1 as const,
    id,
    source,
    documents,
    chunks,
    replaceAll: true as const,
    removeDocumentSlots,
  };
  return { ...payload, hash: await canonicalSearchHashV1(payload) };
}

/** @internal Host-capability validation is performed by the package entrypoint. */
export function createExternalSearchDomainMutationCoordinatorInternalV1(
  binding: Omit<CoordinatorBinding, 'generation'>,
): ExternalSearchDomainMutationCoordinatorV1 {
  const normalized = normalizeBinding(binding);
  const coordinator: ExternalSearchDomainMutationCoordinatorV1 = Object.freeze({
    kind: 'taproot-external-search-domain-mutation-coordinator-v1' as const,
    sealCanonicalMutation: async (
      rawInput: ExternalSearchCanonicalMutationInputV1,
    ) => sealMutation(coordinator, normalized, rawInput),
  });
  coordinatorBindings.set(coordinator, normalized);
  return coordinator;
}

/** @internal The external producer guard is the only caller of this commit. */
export async function commitExternalSearchCanonicalMutationInternalV1(
  coordinator: ExternalSearchDomainMutationCoordinatorV1,
  opaqueMutation: OpaqueExternalSearchCanonicalMutationV1,
): Promise<ExternalSearchCanonicalMutationReceiptV1> {
  const coordinatorBinding = coordinatorBindings.get(coordinator);
  const mutation = mutationBindings.get(opaqueMutation);
  if (
    !coordinatorBinding ||
    !mutation ||
    mutation.coordinator !== coordinator ||
    mutation.coordinatorGeneration !== coordinatorBinding.generation ||
    mutation.attempted
  )
    denied('canonical mutation handle is invalid');
  mutation.attempted = true;

  const context = normalizeAuthorizationContext(mutation.context);
  const state = await currentState(coordinatorBinding.db);
  if (
    state.installationId !== coordinatorBinding.installationId ||
    context.installationId !== state.installationId ||
    context.authorizationRevision !== state.authorizationRevision ||
    !context.capabilities.includes(coordinatorBinding.capability)
  )
    denied('canonical mutation authorization denied');
  const predecessor = await readPersistedSearchSourceRegistryV1(
    coordinatorBinding.db,
    coordinatorBinding.installationId,
    coordinatorBinding.sourceKind,
    mutation.event.sourceId,
  );
  if (
    (predecessor === null && mutation.event.predecessor !== null) ||
    (predecessor !== null &&
      (mutation.event.predecessor === null ||
        predecessor.domain !== coordinatorBinding.domain ||
        predecessor.eventId !== mutation.event.predecessor.eventId ||
        predecessor.sequence !== mutation.event.predecessor.sequence))
  )
    denied('canonical mutation predecessor is stale');

  const searchGeneration = state.searchGeneration + 1;
  if (!Number.isSafeInteger(searchGeneration))
    denied('search generation is exhausted');
  const createdAt = coordinatorBinding.clock().toISOString();
  const prepared = await prepareUnifiedSearchSourceEventStatementsV1(
    coordinatorBinding.db,
    {
      installationId: coordinatorBinding.installationId,
      domain: coordinatorBinding.domain,
      sourceKind: coordinatorBinding.sourceKind,
      sourcePolicyRevision: mutation.sourcePolicyRevision,
      authorizationRevision: state.authorizationRevision,
      searchGeneration,
      createdAt,
    },
    mutation.event,
    coordinatorBinding.changeClasses,
  );
  const advance = coordinatorBinding.db
    .prepare(
      `UPDATE taproot_installation_authorization
       SET search_generation = ?, last_advance_id = ?, updated_at = ?
       WHERE singleton = 1 AND installation_id = ?
         AND authorization_revision = ? AND search_generation = ?
         AND last_advance_id = ?`,
    )
    .bind(
      searchGeneration,
      mutation.event.eventId,
      createdAt,
      state.installationId,
      state.authorizationRevision,
      state.searchGeneration,
      state.lastAdvanceId,
    );
  const fence = coordinatorBinding.db
    .prepare(
      `INSERT INTO taproot_assertions(assertion_key)
       SELECT NULL WHERE NOT EXISTS (
         SELECT 1 FROM taproot_installation_authorization
         WHERE singleton = 1 AND installation_id = ?
           AND authorization_revision = ? AND search_generation = ?
           AND last_advance_id = ?
       )`,
    )
    .bind(
      state.installationId,
      state.authorizationRevision,
      searchGeneration,
      mutation.event.eventId,
    );
  const results = await coordinatorBinding.db.batch([
    ...mutation.statements,
    advance,
    fence,
    ...prepared.statements,
  ]);
  mutationBindings.delete(opaqueMutation);
  return {
    eventId: mutation.event.eventId,
    authorizationRevision: state.authorizationRevision,
    searchGeneration,
    results: results.slice(0, mutation.statements.length),
  };
}

/** @internal Exact binding check used by the external producer guard factory. */
export function inspectExternalSearchDomainMutationCoordinatorInternalV1(
  coordinator: ExternalSearchDomainMutationCoordinatorV1,
): Readonly<
  Pick<
    CoordinatorBinding,
    | 'db'
    | 'installationId'
    | 'domain'
    | 'sourceKind'
    | 'capability'
    | 'changeClasses'
  >
> | null {
  return coordinatorBindings.get(coordinator) ?? null;
}

async function sealMutation(
  coordinator: ExternalSearchDomainMutationCoordinatorV1,
  binding: CoordinatorBinding,
  raw: ExternalSearchCanonicalMutationInputV1,
): Promise<OpaqueExternalSearchCanonicalMutationV1> {
  exactKeys(raw, [
    'canonicalPostState',
    'changeClass',
    'context',
    'eventId',
    'operation',
    'predecessor',
    'sourceId',
    'sourcePolicyRevision',
    'sourceRevision',
    'statements',
  ]);
  if (!Array.isArray(raw.statements) || raw.statements.length === 0)
    denied('canonical mutation statements are required');
  if (raw.statements.length > MAX_DOMAIN_STATEMENTS)
    denied('canonical mutation statement limit exceeded');
  if (
    !Number.isSafeInteger(raw.sourcePolicyRevision) ||
    raw.sourcePolicyRevision < 1
  )
    denied('source policy revision is invalid');
  const sourceHash = await canonicalSearchHashV1(raw.canonicalPostState);
  const event = normalizeUnifiedSearchSourceEventInputV1(
    {
      eventId: raw.eventId,
      sourceId: raw.sourceId,
      operation: raw.operation,
      changeClass: raw.changeClass,
      sourceRevision: raw.sourceRevision,
      sourceHash,
      predecessor: raw.predecessor,
    },
    binding,
  );
  const rawStatements = raw.statements as readonly ExternalSearchDomainSqlV1[];
  const statements = rawStatements.map((value) =>
    prepareDomainSql(binding.db, value),
  );
  const handle: OpaqueExternalSearchCanonicalMutationV1 = Object.freeze({
    kind: 'taproot-external-search-canonical-mutation-v1' as const,
  });
  mutationBindings.set(handle, {
    coordinator,
    coordinatorGeneration: binding.generation,
    context: normalizeAuthorizationContext(raw.context),
    event,
    sourcePolicyRevision: raw.sourcePolicyRevision,
    statements,
    attempted: false,
  });
  return handle;
}

function prepareDomainSql(
  db: D1DatabaseLike,
  raw: ExternalSearchDomainSqlV1,
): SqlitePreparedStatementLike {
  exactKeys(raw, ['sql', 'values']);
  if (
    typeof raw.sql !== 'string' ||
    raw.sql.trim().length === 0 ||
    new TextEncoder().encode(raw.sql).byteLength > MAX_SQL_BYTES ||
    BLOCKED_SQL.test(raw.sql)
  )
    denied('canonical mutation SQL is invalid');
  if (!Array.isArray(raw.values) || raw.values.length > 256)
    denied('canonical mutation values are invalid');
  return db.prepare(raw.sql).bind(...(raw.values as readonly unknown[]));
}

function normalizeBinding(
  raw: Omit<CoordinatorBinding, 'generation'>,
): CoordinatorBinding {
  if (raw.sourceKind !== 'task' && raw.sourceKind !== 'memory')
    denied('only Task and Memory external mutation coordinators are enabled');
  const domain = token(raw.domain, 'domain', 64);
  if (domain !== 'workshop') denied('external source kind owner is invalid');
  const capability = token(raw.capability, 'capability', 128);
  const changeClasses = [
    ...new Set(
      raw.changeClasses.map((value) => token(value, 'changeClass', 64)),
    ),
  ].sort();
  if (changeClasses.length === 0 || changeClasses.length > 32)
    denied('change classes are invalid');
  return {
    ...raw,
    installationId: token(raw.installationId, 'installationId', 128),
    domain,
    capability,
    changeClasses: Object.freeze(changeClasses),
    generation: Object.freeze({}),
  };
}

function normalizeProducerDescriptor(
  raw: ExternalSearchProducerDescriptorV1,
): Readonly<ExternalSearchProducerDescriptorV1> {
  exactKeys(raw, [
    'authorizationContractVersion',
    'contractVersion',
    'owningDomain',
    'producerFingerprint',
    'projectionVersion',
    'sourceKind',
    'version',
  ]);
  if (raw.version !== 1) denied('external producer version is invalid');
  if (raw.sourceKind !== 'task' && raw.sourceKind !== 'memory')
    denied('external producer kind is not enabled');
  if (raw.owningDomain !== 'workshop')
    denied('external producer owner is invalid');
  if (!/^[a-f0-9]{64}$/u.test(raw.producerFingerprint))
    denied('producer fingerprint is invalid');
  return Object.freeze({
    version: 1,
    sourceKind: raw.sourceKind,
    owningDomain: 'workshop',
    producerFingerprint: raw.producerFingerprint,
    contractVersion: token(raw.contractVersion, 'contractVersion', 128),
    projectionVersion: token(raw.projectionVersion, 'projectionVersion', 128),
    authorizationContractVersion: token(
      raw.authorizationContractVersion,
      'authorizationContractVersion',
      128,
    ),
  });
}

function validateCallbacks(callbacks: ExternalSearchProducerCallbacksV1): void {
  exactKeys(callbacks, [
    'authorizeCurrentReference',
    'enumerateLegacyCurrent',
    'hydrateCurrentReference',
    'loadCurrent',
    'projectCurrent',
  ]);
  for (const value of Object.values(callbacks))
    if (typeof value !== 'function')
      denied('external producer callback is invalid');
}

async function registerManifest(
  binding: { db: D1DatabaseLike; installationId: string; clock: () => Date },
  descriptor: Readonly<ExternalSearchProducerDescriptorV1>,
): Promise<void> {
  const current = await binding.db
    .prepare(
      `SELECT producer_fingerprint, state, manifest_revision
       FROM taproot_unified_search_producer_adoptions
       WHERE installation_id = ? AND source_kind = ?`,
    )
    .bind(binding.installationId, descriptor.sourceKind)
    .all<Record<string, unknown>>();
  const previous = current.results[0];
  const previousFingerprint = previous?.producer_fingerprint ?? null;
  const same = previousFingerprint === descriptor.producerFingerprint;
  const persistedManifest = await binding.db
    .prepare(
      `SELECT owning_domain, contract_version, projection_version,
              authorization_contract_version, manifest_revision
       FROM taproot_unified_search_producer_manifests
       WHERE installation_id = ? AND source_kind = ?
         AND producer_fingerprint = ?`,
    )
    .bind(
      binding.installationId,
      descriptor.sourceKind,
      descriptor.producerFingerprint,
    )
    .all<Record<string, unknown>>();
  const manifest = persistedManifest.results[0];
  if (
    manifest &&
    (manifest.owning_domain !== descriptor.owningDomain ||
      manifest.contract_version !== descriptor.contractVersion ||
      manifest.projection_version !== descriptor.projectionVersion ||
      manifest.authorization_contract_version !==
        descriptor.authorizationContractVersion)
  )
    denied('producer fingerprint manifest mismatch');
  const revision = same
    ? Number(manifest?.manifest_revision ?? previous?.manifest_revision ?? 1)
    : Number(previous?.manifest_revision ?? 0) + 1;
  const now = binding.clock().toISOString();
  const auditId = await canonicalSearchHashV1({
    version: 1,
    installationId: binding.installationId,
    kind: descriptor.sourceKind,
    fingerprint: descriptor.producerFingerprint,
    revision,
  });
  await binding.db.batch([
    binding.db
      .prepare(
        `INSERT INTO taproot_unified_search_producer_manifests(
           installation_id, source_kind, producer_fingerprint, owning_domain,
           contract_version, projection_version,
           authorization_contract_version, manifest_revision, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id, source_kind, producer_fingerprint)
         DO NOTHING`,
      )
      .bind(
        binding.installationId,
        descriptor.sourceKind,
        descriptor.producerFingerprint,
        descriptor.owningDomain,
        descriptor.contractVersion,
        descriptor.projectionVersion,
        descriptor.authorizationContractVersion,
        revision,
        now,
      ),
    binding.db
      .prepare(
        `INSERT INTO taproot_unified_search_producer_adoptions(
           installation_id, source_kind, producer_fingerprint, state,
           manifest_revision, updated_at)
         VALUES (?, ?, ?, 'backfilling', ?, ?)
         ON CONFLICT(installation_id, source_kind) DO NOTHING`,
      )
      .bind(
        binding.installationId,
        descriptor.sourceKind,
        descriptor.producerFingerprint,
        revision,
        now,
      ),
    binding.db
      .prepare(
        `UPDATE taproot_unified_search_producer_adoptions
         SET producer_fingerprint = ?, state = ?,
             opaque_cursor = CASE WHEN ? THEN opaque_cursor ELSE NULL END,
             enumerated_count = CASE WHEN ? THEN enumerated_count ELSE 0 END,
             adopted_count = CASE WHEN ? THEN adopted_count ELSE 0 END,
             manifest_revision = ?, last_error_code = NULL, updated_at = ?
         WHERE installation_id = ? AND source_kind = ?
           AND (producer_fingerprint IS NOT ? OR state != 'ready')`,
      )
      .bind(
        descriptor.producerFingerprint,
        same && previous?.state === 'ready' ? 'ready' : 'backfilling',
        same ? 1 : 0,
        same ? 1 : 0,
        same ? 1 : 0,
        revision,
        now,
        binding.installationId,
        descriptor.sourceKind,
        descriptor.producerFingerprint,
      ),
    binding.db
      .prepare(
        `INSERT INTO taproot_unified_search_producer_admin_audit(
           audit_id, installation_id, source_kind, event_type,
           producer_fingerprint, previous_producer_fingerprint,
           manifest_revision, principal_id, details_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'host-assembly', '{}', ?)
         ON CONFLICT(audit_id) DO NOTHING`,
      )
      .bind(
        `producer:${auditId}`,
        binding.installationId,
        descriptor.sourceKind,
        same ? 'register' : 'fingerprint-switch',
        descriptor.producerFingerprint,
        previousFingerprint,
        revision,
        now,
      ),
  ]);
}

function runtimeKey(
  installationId: string,
  sourceKind: UnifiedSearchSourceKindV1,
  fingerprint: string,
): string {
  return `${installationId}\u0000${sourceKind}\u0000${fingerprint}`;
}

async function adoptLegacyPage(
  binding: { db: D1DatabaseLike; installationId: string; clock: () => Date },
  descriptor: Readonly<ExternalSearchProducerDescriptorV1>,
  callbacks: ExternalSearchProducerCallbacksV1,
  policyAuthority: ExternalSearchDomainPolicyAuthorityV1,
  coordinator: CoordinatorBinding,
  rawContext: AuthorizationContext,
  options: { limit: number },
): Promise<{ enumerated: number; adopted: number; complete: boolean }> {
  exactKeys(options, ['limit']);
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  )
    denied('legacy adoption limit is invalid');
  const context = normalizeAuthorizationContext(rawContext);
  const state = await currentState(binding.db);
  if (
    context.installationId !== state.installationId ||
    context.authorizationRevision !== state.authorizationRevision ||
    !context.capabilities.includes('search:admin')
  )
    denied('legacy adoption authorization denied');
  const adoption = await binding.db
    .prepare(
      `SELECT producer_fingerprint, state, opaque_cursor, enumerated_count,
              adopted_count, manifest_revision
       FROM taproot_unified_search_producer_adoptions
       WHERE installation_id = ? AND source_kind = ?`,
    )
    .bind(binding.installationId, descriptor.sourceKind)
    .all<Record<string, unknown>>();
  const row = adoption.results[0];
  if (
    !row ||
    row.producer_fingerprint !== descriptor.producerFingerprint ||
    row.state !== 'backfilling'
  )
    denied('legacy adoption is not active');
  if (row.opaque_cursor !== null && typeof row.opaque_cursor !== 'string')
    denied('legacy adoption cursor is invalid');
  try {
    const page = await callbacks.enumerateLegacyCurrent({
      cursor: row.opaque_cursor,
      limit: options.limit,
    });
    exactKeys(page, ['nextCursor', 'sourceIds']);
    if (!Array.isArray(page.sourceIds) || page.sourceIds.length > options.limit)
      denied('legacy adoption page is invalid');
    const sourceIds = page.sourceIds.map((value) =>
      token(value, 'sourceId', 256),
    );
    if (new Set(sourceIds).size !== sourceIds.length)
      denied('legacy adoption page contains duplicates');
    const nextCursor =
      page.nextCursor === null
        ? null
        : token(page.nextCursor, 'nextCursor', 1024);
    let adopted = 0;
    for (const sourceId of sourceIds) {
      const loaded = await callbacks.loadCurrent({
        sourceId,
        expectedSourceRevision: null,
      });
      if (!loaded) continue;
      validateLoadedSource(loaded, sourceId);
      const authorization = await callbacks.authorizeCurrentReference(
        policyAuthority,
        {
          sourceId,
          sourceRevision: loaded.sourceRevision,
          sourcePolicyRevision: loaded.sourcePolicyRevision,
        },
      );
      const rawPlan = await callbacks.projectCurrent({
        source: loaded,
        authorization,
      });
      await canonicalSearchHashV1(rawPlan);
      await canonicalSearchHashV1(authorization);
      if (
        await adoptOneSource(
          binding,
          descriptor,
          coordinator,
          loaded,
          state.authorizationRevision,
        )
      )
        adopted += 1;
    }
    const complete = nextCursor === null;
    const now = binding.clock().toISOString();
    const auditId = await canonicalSearchHashV1({
      version: 1,
      kind: descriptor.sourceKind,
      fingerprint: descriptor.producerFingerprint,
      cursor: row.opaque_cursor ?? null,
      nextCursor,
      sourceIds,
    });
    const adoptionAdvance = binding.db
      .prepare(
        `UPDATE taproot_unified_search_producer_adoptions
           SET state = ?, opaque_cursor = ?,
               enumerated_count = enumerated_count + ?,
               adopted_count = adopted_count + ?, last_error_code = NULL,
               updated_at = ?
           WHERE installation_id = ? AND source_kind = ?
             AND producer_fingerprint = ? AND state = 'backfilling'
             AND opaque_cursor IS ?`,
      )
      .bind(
        complete ? 'ready' : 'backfilling',
        nextCursor,
        sourceIds.length,
        adopted,
        now,
        binding.installationId,
        descriptor.sourceKind,
        descriptor.producerFingerprint,
        row.opaque_cursor,
      );
    const adoptionFence = binding.db
      .prepare(
        `INSERT INTO taproot_assertions(assertion_key)
         SELECT NULL WHERE NOT EXISTS (
           SELECT 1 FROM taproot_unified_search_producer_adoptions
           WHERE installation_id = ? AND source_kind = ?
             AND producer_fingerprint = ? AND state = ?
             AND opaque_cursor IS ?
             AND enumerated_count = ? AND adopted_count = ?
         )`,
      )
      .bind(
        binding.installationId,
        descriptor.sourceKind,
        descriptor.producerFingerprint,
        complete ? 'ready' : 'backfilling',
        nextCursor,
        Number(row.enumerated_count) + sourceIds.length,
        Number(row.adopted_count) + adopted,
      );
    await binding.db.batch([
      adoptionAdvance,
      adoptionFence,
      binding.db
        .prepare(
          `INSERT INTO taproot_unified_search_producer_admin_audit(
             audit_id, installation_id, source_kind, event_type,
             producer_fingerprint, manifest_revision, principal_id,
             details_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `adoption:${auditId}`,
          binding.installationId,
          descriptor.sourceKind,
          complete ? 'adoption-ready' : 'adoption-page',
          descriptor.producerFingerprint,
          Number(row.manifest_revision),
          context.principalId,
          JSON.stringify({ version: 1, enumerated: sourceIds.length, adopted }),
          now,
        ),
    ]);
    return { enumerated: sourceIds.length, adopted, complete };
  } catch {
    const now = binding.clock().toISOString();
    const failureAuditId = await canonicalSearchHashV1({
      version: 1,
      kind: descriptor.sourceKind,
      fingerprint: descriptor.producerFingerprint,
      cursor: row.opaque_cursor ?? null,
      enumeratedCount: Number(row.enumerated_count),
      adoptedCount: Number(row.adopted_count),
    });
    await binding.db.batch([
      binding.db
        .prepare(
          `UPDATE taproot_unified_search_producer_adoptions
         SET state = 'failed', last_error_code = 'producer-adoption-failed',
             updated_at = ?
         WHERE installation_id = ? AND source_kind = ?
           AND producer_fingerprint = ? AND state = 'backfilling'
           AND opaque_cursor IS ? AND enumerated_count = ?
           AND adopted_count = ?`,
        )
        .bind(
          now,
          binding.installationId,
          descriptor.sourceKind,
          descriptor.producerFingerprint,
          row.opaque_cursor,
          Number(row.enumerated_count),
          Number(row.adopted_count),
        ),
      binding.db
        .prepare(
          `INSERT INTO taproot_unified_search_producer_admin_audit(
           audit_id, installation_id, source_kind, event_type,
           producer_fingerprint, manifest_revision, principal_id,
           details_json, created_at
         )
         SELECT ?, installation_id, source_kind, 'adoption-failed',
                producer_fingerprint, manifest_revision, ?,
                '{"version":1,"errorCode":"producer-adoption-failed"}', ?
         FROM taproot_unified_search_producer_adoptions
         WHERE installation_id = ? AND source_kind = ?
           AND producer_fingerprint = ? AND state = 'failed'
           AND opaque_cursor IS ? AND enumerated_count = ?
           AND adopted_count = ? AND updated_at = ?
         ON CONFLICT(audit_id) DO NOTHING`,
        )
        .bind(
          `adoption-failed:${failureAuditId}`,
          context.principalId,
          now,
          binding.installationId,
          descriptor.sourceKind,
          descriptor.producerFingerprint,
          row.opaque_cursor,
          Number(row.enumerated_count),
          Number(row.adopted_count),
          now,
        ),
    ]);
    throw new InvalidAuthorizationError('external producer adoption failed');
  }
}

async function adoptOneSource(
  binding: { db: D1DatabaseLike; installationId: string; clock: () => Date },
  descriptor: Readonly<ExternalSearchProducerDescriptorV1>,
  coordinator: CoordinatorBinding,
  loaded: ExternalSearchLoadedSourceV1,
  expectedAuthorizationRevision: number,
): Promise<boolean> {
  const existing = await readPersistedSearchSourceRegistryV1(
    binding.db,
    binding.installationId,
    descriptor.sourceKind,
    loaded.sourceId,
  );
  if (existing?.sourceRevision === loaded.sourceRevision) return false;
  const state = await currentState(binding.db);
  if (state.authorizationRevision !== expectedAuthorizationRevision)
    denied('authorization changed during legacy adoption');
  const sourceHash = await canonicalSearchHashV1(loaded.canonical);
  const eventHash = await canonicalSearchHashV1({
    version: 1,
    installationId: binding.installationId,
    kind: descriptor.sourceKind,
    sourceId: loaded.sourceId,
    sourceRevision: loaded.sourceRevision,
    sourceHash,
  });
  const event = normalizeUnifiedSearchSourceEventInputV1(
    {
      eventId: `adopt:${eventHash}`,
      sourceId: loaded.sourceId,
      operation: 'upsert',
      changeClass: coordinator.changeClasses.includes('canonical')
        ? 'canonical'
        : coordinator.changeClasses[0]!,
      sourceRevision: loaded.sourceRevision,
      sourceHash,
      predecessor: existing
        ? { eventId: existing.eventId, sequence: existing.sequence }
        : null,
    },
    coordinator,
  );
  const searchGeneration = state.searchGeneration + 1;
  const createdAt = binding.clock().toISOString();
  const prepared = await prepareUnifiedSearchSourceEventStatementsV1(
    binding.db,
    {
      installationId: binding.installationId,
      domain: descriptor.owningDomain,
      sourceKind: descriptor.sourceKind,
      sourcePolicyRevision: loaded.sourcePolicyRevision,
      authorizationRevision: state.authorizationRevision,
      searchGeneration,
      createdAt,
    },
    event,
    coordinator.changeClasses,
  );
  const advance = binding.db
    .prepare(
      `UPDATE taproot_installation_authorization
       SET search_generation = ?, last_advance_id = ?, updated_at = ?
       WHERE singleton = 1 AND installation_id = ?
         AND authorization_revision = ? AND search_generation = ?
         AND last_advance_id = ?`,
    )
    .bind(
      searchGeneration,
      event.eventId,
      createdAt,
      binding.installationId,
      state.authorizationRevision,
      state.searchGeneration,
      state.lastAdvanceId,
    );
  const fence = binding.db
    .prepare(
      `INSERT INTO taproot_assertions(assertion_key)
       SELECT NULL WHERE NOT EXISTS (
         SELECT 1 FROM taproot_installation_authorization
         WHERE singleton = 1 AND installation_id = ?
           AND authorization_revision = ? AND search_generation = ?
           AND last_advance_id = ?
       )`,
    )
    .bind(
      binding.installationId,
      state.authorizationRevision,
      searchGeneration,
      event.eventId,
    );
  await binding.db.batch([advance, fence, ...prepared.statements]);
  return true;
}

function validateLoadedSource(
  raw: ExternalSearchLoadedSourceV1,
  expectedSourceId: string,
): void {
  exactKeys(raw, [
    'canonical',
    'sourceId',
    'sourcePolicyRevision',
    'sourceRevision',
  ]);
  if (token(raw.sourceId, 'sourceId', 256) !== expectedSourceId)
    denied('loaded source identity mismatch');
  token(raw.sourceRevision, 'sourceRevision', 128);
  if (
    !Number.isSafeInteger(raw.sourcePolicyRevision) ||
    raw.sourcePolicyRevision < 1
  )
    denied('loaded source policy revision is invalid');
}

async function normalizeExternalAuthorization(
  raw: ExternalSearchAuthorizationV1,
  source: SearchProjectionSourceEventV1,
): Promise<SearchAuthorizationEnvelopeValueV1> {
  exactKeys(raw, [
    'ownerPrincipalId',
    'sourceId',
    'sourcePolicyRevision',
    'sourceRevision',
    'version',
    'visibility',
    'workspaceId',
  ]);
  if (
    raw.version !== 1 ||
    raw.sourceId !== source.sourceId ||
    raw.sourceRevision !== source.sourceRevision ||
    raw.sourcePolicyRevision !== source.sourcePolicyRevision
  )
    denied('external authorization does not match the source');
  const normalized = {
    version: 1 as const,
    sourceKind: source.kind,
    sourceId: source.sourceId,
    sourceRevision: source.sourceRevision,
    installationId: source.installationId,
    workspaceId:
      raw.workspaceId === null
        ? null
        : token(raw.workspaceId, 'workspaceId', 128),
    ownerPrincipalId: token(raw.ownerPrincipalId, 'ownerPrincipalId', 128),
    sourcePolicyRevision: source.sourcePolicyRevision,
    authorizationRevision: source.authorizationRevision,
    visibility: normalizeVisibilityScope(raw.visibility),
  };
  return {
    ...normalized,
    fingerprint: await canonicalSearchHashV1({
      version: 1,
      installationId: normalized.installationId,
      workspaceId: normalized.workspaceId,
      ownerPrincipalId: normalized.ownerPrincipalId,
      sourcePolicyRevision: normalized.sourcePolicyRevision,
      authorizationRevision: normalized.authorizationRevision,
      visibility: normalized.visibility,
    }),
  };
}

async function buildExternalDocument(
  sourceKind: 'task' | 'memory',
  source: SearchProjectionSourceEventV1,
  authorization: SearchAuthorizationEnvelopeValueV1,
  raw: ExternalSearchProjectionDocumentInputV1,
): Promise<DerivedSearchDocumentV1> {
  exactKeys(raw, [
    'canonicalReference',
    'documentSlot',
    'filterMetadata',
    'segments',
    'text',
  ]);
  const documentSlot = token(raw.documentSlot, 'documentSlot', 256);
  const text = boundedText(
    raw.text,
    'documentText',
    UNIFIED_SEARCH_LIMITS.maxProjectionTextBytes,
  );
  const canonicalReference = normalizeExternalReference(
    raw.canonicalReference,
    sourceKind,
  );
  const rootReference = normalizeExternalReference(
    sourceKind === 'task'
      ? { kind: 'task', taskId: source.sourceId }
      : { kind: 'memory', memoryId: source.sourceId },
    sourceKind,
  );
  const filterMetadata = normalizeUnifiedSearchFiltersV1(raw.filterMetadata, [
    sourceKind,
  ]);
  if (!Array.isArray(raw.segments) || raw.segments.length > 256)
    denied('external projection segments are invalid');
  const rawSegments = raw.segments as readonly SearchProjectionSegmentV1[];
  const segments = rawSegments.map((segment, index) =>
    normalizeExternalSegment(segment, text, index),
  );
  const identity = {
    projectionVersion: 'taproot-unified-search-projection-v1',
    installationId: source.installationId,
    documentSlot,
    rootReference,
    canonicalReference,
  };
  const id = await deriveSearchContractIdV1('document', identity);
  const payload = {
    version: 1 as const,
    projectionVersion: 'taproot-unified-search-projection-v1' as const,
    id,
    documentSlot,
    kind: sourceKind,
    source,
    rootReference,
    canonicalReference,
    authorization,
    filterMetadata,
    text,
    segments,
  };
  return { ...payload, hash: await canonicalSearchHashV1(payload) };
}

function normalizeExternalReference(
  raw: UnifiedSearchReferenceV1,
  expectedKind: 'task' | 'memory',
): UnifiedSearchReferenceV1 {
  if (expectedKind === 'task') {
    exactKeys(raw, ['kind', 'taskId']);
    if (raw.kind !== 'task')
      denied('external canonical reference kind mismatch');
    return { kind: 'task', taskId: token(raw.taskId, 'taskId', 256) };
  }
  exactKeys(raw, ['kind', 'memoryId']);
  if (raw.kind !== 'memory')
    denied('external canonical reference kind mismatch');
  return { kind: 'memory', memoryId: token(raw.memoryId, 'memoryId', 256) };
}

function normalizeExternalSegment(
  raw: SearchProjectionSegmentV1,
  documentText: string,
  index: number,
): SearchProjectionSegmentV1 {
  exactKeys(raw, [
    'documentEnd',
    'documentStart',
    'field',
    'language',
    'sourceId',
    'text',
  ]);
  const fields = new Set([
    'label',
    'alias',
    'description',
    'type',
    'statement',
    'title',
    'content',
    'prompt',
    'result',
    'status',
  ]);
  if (!fields.has(raw.field))
    denied(`external segment ${index} field is invalid`);
  if (
    !Number.isSafeInteger(raw.documentStart) ||
    !Number.isSafeInteger(raw.documentEnd) ||
    raw.documentStart < 0 ||
    raw.documentEnd < raw.documentStart ||
    raw.documentEnd > documentText.length
  )
    denied(`external segment ${index} range is invalid`);
  const text = boundedText(
    raw.text,
    `segment ${index} text`,
    UNIFIED_SEARCH_LIMITS.maxProjectionTextBytes,
  );
  if (documentText.slice(raw.documentStart, raw.documentEnd) !== text)
    denied(`external segment ${index} text does not match its range`);
  return {
    field: raw.field,
    sourceId: token(raw.sourceId, `segment ${index} sourceId`, 256),
    language:
      raw.language === null
        ? null
        : token(raw.language, `segment ${index} language`, 64),
    text,
    documentStart: raw.documentStart,
    documentEnd: raw.documentEnd,
  };
}

async function chunkExternalDocument(
  document: DerivedSearchDocumentV1,
  maxChunkBytes: number,
): Promise<DerivedSearchChunkV1[]> {
  if (
    !Number.isSafeInteger(maxChunkBytes) ||
    maxChunkBytes < UNIFIED_SEARCH_LIMITS.minChunkBytes ||
    maxChunkBytes > UNIFIED_SEARCH_LIMITS.maxChunkBytes
  )
    denied('external chunk bound is invalid');
  const encoder = new TextEncoder();
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  let end = 0;
  let bytes = 0;
  for (const codePoint of document.text) {
    const size = encoder.encode(codePoint).byteLength;
    if (bytes > 0 && bytes + size > maxChunkBytes) {
      ranges.push({ start, end });
      start = end;
      bytes = 0;
    }
    if (size > maxChunkBytes)
      denied('external Unicode scalar exceeds chunk bound');
    end += codePoint.length;
    bytes += size;
  }
  if (end > start || document.text.length === 0) ranges.push({ start, end });
  if (ranges.length > UNIFIED_SEARCH_LIMITS.maxChunksPerDocument)
    denied('external projection chunk limit exceeded');
  const chunks: DerivedSearchChunkV1[] = [];
  for (const [ordinal, range] of ranges.entries()) {
    const text = document.text.slice(range.start, range.end);
    const trace = document.segments
      .filter(
        (entry) =>
          entry.documentStart < range.end && entry.documentEnd > range.start,
      )
      .map((entry) => {
        const overlapStart = Math.max(entry.documentStart, range.start);
        const overlapEnd = Math.min(entry.documentEnd, range.end);
        return {
          field: entry.field,
          sourceId: entry.sourceId,
          language: entry.language,
          documentStart: overlapStart,
          documentEnd: overlapEnd,
          chunkStart: overlapStart - range.start,
          chunkEnd: overlapEnd - range.start,
        };
      });
    const id = await deriveSearchContractIdV1('chunk', {
      documentId: document.id,
      ordinal,
      documentStart: range.start,
      documentEnd: range.end,
      text,
    });
    const payload = {
      version: 1 as const,
      id,
      documentId: document.id,
      ordinal,
      canonical: false as const,
      text,
      documentStart: range.start,
      documentEnd: range.end,
      trace,
    };
    chunks.push({ ...payload, hash: await canonicalSearchHashV1(payload) });
  }
  return chunks;
}

function boundedText(
  value: unknown,
  name: string,
  maximumBytes: number,
): string {
  if (typeof value !== 'string' || value.length === 0)
    denied(`${name} is invalid`);
  const normalized = value.normalize('NFC');
  if (new TextEncoder().encode(normalized).byteLength > maximumBytes)
    denied(`${name} exceeds its bound`);
  return normalized;
}

async function currentState(db: D1DatabaseLike): Promise<{
  installationId: string;
  authorizationRevision: number;
  searchGeneration: number;
  lastAdvanceId: string;
}> {
  const result = await db
    .prepare(
      `SELECT installation_id, authorization_revision, search_generation,
              last_advance_id
       FROM taproot_installation_authorization WHERE singleton = 1`,
    )
    .all<Record<string, unknown>>();
  const row = result.results[0];
  if (!row) denied('installation authorization is unavailable');
  return {
    installationId: String(row.installation_id),
    authorizationRevision: Number(row.authorization_revision),
    searchGeneration: Number(row.search_generation),
    lastAdvanceId: String(row.last_advance_id),
  };
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    denied('canonical mutation input is invalid');
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    keys.length !== wanted.length ||
    keys.some((key, index) => key !== wanted[index])
  )
    denied('canonical mutation input fields are invalid');
}

function token(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    !/^[a-z0-9][a-z0-9._:-]*$/u.test(value)
  )
    denied(`${name} is invalid`);
  return value;
}

function denied(message: string): never {
  throw new InvalidAuthorizationError(message);
}
