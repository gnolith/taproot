import type {
  D1DatabaseLike,
  SqlitePreparedStatementLike,
  SqliteResultLike,
} from './sqlite-types.js';
import type { TaprootHostWriteCapability } from './assembly-authority.js';
import { assertTaprootHostWriteCapabilityInternal } from './assembly-authority.js';
import { normalizeAuthorizationContext } from './authorization.js';
import { InvalidAuthorizationError } from './errors.js';
import {
  canonicalSearchHashV1,
  deriveSearchContractIdV1,
  UNIFIED_SEARCH_LIMITS,
  type DerivedSearchChunkV1,
  type DerivedSearchDocumentV1,
  type SearchProjectionPlanV1,
  type SearchProjectionSegmentV1,
  type SearchProjectionSourceEventV1,
  type UnifiedSearchFiltersV1,
  type UnifiedSearchReferenceV1,
} from './search-contract.js';
import {
  externalKindBindingInternal,
  registrationForStorageKeyInternal,
  type ExternalProducerRegistrationCapability,
  type ExternalSearchKind,
} from './search-kinds.js';
import {
  prepareUnifiedSearchSourceEventStatementsV1,
  readPersistedSearchSourceRegistryV1,
  type UnifiedSearchSourcePredecessorV1,
} from './search-source-events.js';
import type { AuthorizationContext } from './types.js';

const MAX_COMMIT_ATTEMPTS = 64;
const MAX_OWNER_STATEMENTS = 100;
const encoder = new TextEncoder();

export interface ProducerDescriptor {
  registration: ExternalProducerRegistrationCapability;
  implementationVersion: string;
  fingerprint: string;
  projectionVersion: string;
  changeClasses: readonly string[];
}

export interface ProducerSource {
  sourceId: string;
  sourceRevision: string;
  sourcePolicyRevision: number;
  canonical: unknown;
}

export interface ExternalSearchReference {
  kind: ExternalSearchKind;
  sourceId: string;
  sourceRevision: string;
}

export interface ExternalProjectedSearchDocumentV1 {
  documentSlot?: string;
  title?: string;
  text: string;
  language?: string;
  filters?: Readonly<Record<string, unknown>>;
}

export interface ExternalProducer {
  descriptor: ProducerDescriptor;
  enumerate(
    cursor: string | null,
    limit: number,
  ): Promise<{ ids: readonly string[]; cursor: string | null }>;
  loadExact(sourceId: string, sourceRevision?: string): Promise<ProducerSource>;
  project(source: ProducerSource): Promise<ExternalProjectedSearchDocumentV1>;
  authorize(
    reference: ExternalSearchReference,
    context: AuthorizationContext,
  ): Promise<boolean>;
  hydrate(
    reference: ExternalSearchReference,
    context: AuthorizationContext,
  ): Promise<unknown>;
}

export interface OwnerMutationParticipant {
  readonly kind: 'taproot-owner-mutation-participant-v1';
  readonly ownerRegistrationId: string;
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly generation: number;
}

export interface RegisteredProducerMutationIssuer {
  seal(input: {
    sourceId: string;
    sourceRevision: string;
    predecessor: UnifiedSearchSourcePredecessorV1 | null;
    ownerMutationToken: unknown;
  }): Promise<OwnerMutationParticipant>;
}

export interface ExternalProducerMutationReceiptV1 {
  eventId: string;
  authorizationRevision: number;
  generation: number;
  results: readonly SqliteResultLike[];
}

export interface RegisteredExternalProducerV1 {
  readonly kind: ExternalSearchKind;
  readonly issuer: RegisteredProducerMutationIssuer;
  currentPredecessor(
    sourceId: string,
  ): Promise<Readonly<UnifiedSearchSourcePredecessorV1> | null>;
  commit(
    participant: OwnerMutationParticipant,
  ): Promise<ExternalProducerMutationReceiptV1>;
  adopt(
    context: AuthorizationContext,
    input: { cursor?: string | null; limit: number },
  ): Promise<{ enumerated: number; adopted: number; cursor: string | null }>;
}

interface RuntimeBinding {
  db: D1DatabaseLike;
  installationId: string;
  registrationId: string;
  storageKey: string;
  ownerDomain: string;
  adapter: {
    prepare(ownerMutationToken: unknown): Promise<readonly unknown[]>;
  };
  producer: ExternalProducer;
  descriptor: Readonly<ProducerDescriptor>;
  clock: () => Date;
}

interface ParticipantBinding {
  runtime: RuntimeBinding;
  predecessor: UnifiedSearchSourcePredecessorV1 | null;
  ownerMutationToken: unknown;
  eventId: string;
  status: 'fresh' | 'committing' | 'committed' | 'failed';
}

const runtimeByConnection = new WeakMap<object, Map<string, RuntimeBinding>>();
const participantBindings = new WeakMap<object, ParticipantBinding>();
const commitLocks = new WeakMap<object, Map<string, Promise<void>>>();

export async function registerExternalProducerV1(
  db: D1DatabaseLike,
  options: { baseIri: string; clock?: () => Date },
  authority: TaprootHostWriteCapability,
  producer: ExternalProducer,
): Promise<RegisteredExternalProducerV1> {
  assertTaprootHostWriteCapabilityInternal(db, options, authority);
  validateProducer(producer);
  const kindBinding = externalKindBindingInternal(
    producer.descriptor.registration,
  );
  if (kindBinding.db !== db)
    denied('external producer registration belongs to another connection');
  const descriptor = normalizeDescriptor(producer.descriptor);
  const runtime: RuntimeBinding = {
    db,
    installationId: kindBinding.installationId,
    registrationId: kindBinding.registrationId,
    storageKey: kindBinding.storageKey,
    ownerDomain: kindBinding.ownerDomain,
    adapter: kindBinding.adapter,
    producer,
    descriptor,
    clock: options.clock ?? (() => new Date()),
  };
  await persistDescriptor(runtime);
  let runtimes = runtimeByConnection.get(db);
  if (!runtimes) {
    runtimes = new Map();
    runtimeByConnection.set(db, runtimes);
  }
  const key = runtimeKey(
    runtime.installationId,
    runtime.storageKey,
    descriptor.fingerprint,
  );
  const existing = runtimes.get(key);
  if (existing && existing.producer !== producer)
    denied('external producer runtime is already registered');
  runtimes.set(key, runtime);

  const issuer: RegisteredProducerMutationIssuer = Object.freeze({
    seal: (input: {
      sourceId: string;
      sourceRevision: string;
      predecessor: UnifiedSearchSourcePredecessorV1 | null;
      ownerMutationToken: unknown;
    }) => sealParticipant(runtime, input),
  });
  return Object.freeze({
    kind: descriptor.registration.kind,
    issuer,
    currentPredecessor: (sourceId: string) =>
      currentPredecessor(runtime, sourceId),
    commit: (participant: OwnerMutationParticipant) =>
      commitParticipant(runtime, participant),
    adopt: (
      context: AuthorizationContext,
      input: { cursor?: string | null; limit: number },
    ) => adopt(runtime, context, input),
  });
}

async function currentPredecessor(
  runtime: RuntimeBinding,
  rawSourceId: string,
): Promise<Readonly<UnifiedSearchSourcePredecessorV1> | null> {
  const sourceId = token(rawSourceId, 'sourceId', 256);
  const persisted = await readPersistedSearchSourceRegistryV1(
    runtime.db,
    runtime.installationId,
    runtime.storageKey,
    sourceId,
  );
  return persisted
    ? Object.freeze({
        eventId: persisted.eventId,
        sequence: persisted.sequence,
      })
    : null;
}

/** @internal */
export function lookupExternalSearchProducerRuntimeInternalV1(
  db: D1DatabaseLike,
  installationId: string,
  storageKey: string,
  fingerprint: string | null,
): RuntimeBinding | null {
  if (!fingerprint) return null;
  return (
    runtimeByConnection
      .get(db)
      ?.get(runtimeKey(installationId, storageKey, fingerprint)) ?? null
  );
}

/** @internal */
export async function authorizeExternalSearchReferenceInternalV1(
  runtime: RuntimeBinding,
  sourceId: string,
  sourceRevision: string,
  context: AuthorizationContext,
): Promise<boolean> {
  const normalized = normalizeAuthorizationContext(context);
  if (normalized.installationId !== runtime.installationId) return false;
  const before = await currentFence(runtime.db, runtime.installationId);
  if (before.authorizationRevision !== normalized.authorizationRevision)
    return false;
  const allowed = await runtime.producer.authorize(
    {
      kind: runtime.descriptor.registration.kind,
      sourceId,
      sourceRevision,
    },
    normalized,
  );
  const after = await currentFence(runtime.db, runtime.installationId);
  return (
    allowed === true &&
    after.authorizationRevision === before.authorizationRevision &&
    after.generation === before.generation
  );
}

/** @internal */
export async function hydrateExternalSearchReferenceInternalV1(
  runtime: RuntimeBinding,
  sourceId: string,
  sourceRevision: string,
  context: AuthorizationContext,
): Promise<unknown> {
  if (
    !(await authorizeExternalSearchReferenceInternalV1(
      runtime,
      sourceId,
      sourceRevision,
      context,
    ))
  )
    denied('external reference is not authorized');
  const value = await runtime.producer.hydrate(
    {
      kind: runtime.descriptor.registration.kind,
      sourceId,
      sourceRevision,
    },
    normalizeAuthorizationContext(context),
  );
  const loaded = normalizeSource(
    await runtime.producer.loadExact(sourceId, sourceRevision),
  );
  if (loaded.sourceId !== sourceId || loaded.sourceRevision !== sourceRevision)
    denied('external producer advanced during hydration');
  if (
    !(await authorizeExternalSearchReferenceInternalV1(
      runtime,
      sourceId,
      sourceRevision,
      context,
    ))
  )
    denied('external authorization changed during hydration');
  return value;
}

/** @internal */
export async function loadExternalSearchSourceInternalV1(
  runtime: RuntimeBinding,
  sourceId: string,
  sourceRevision: string,
): Promise<ProducerSource | null> {
  try {
    const source = normalizeSource(
      await runtime.producer.loadExact(sourceId, sourceRevision),
    );
    return source.sourceId === sourceId &&
      source.sourceRevision === sourceRevision
      ? source
      : null;
  } catch {
    return null;
  }
}

/** @internal */
export async function buildExternalSearchProjectionPlanInternalV1(
  runtime: RuntimeBinding,
  loaded: ProducerSource,
  source: SearchProjectionSourceEventV1,
  maxChunkBytes: number,
): Promise<SearchProjectionPlanV1> {
  const normalized = normalizeSource(loaded);
  if (
    normalized.sourceId !== source.sourceId ||
    normalized.sourceRevision !== source.sourceRevision
  )
    denied('external source does not match the persisted event');
  const projected = normalizeProjectedDocument(
    await runtime.producer.project(normalized),
  );
  const registration =
    registrationForStorageKeyInternal(
      runtime.db,
      runtime.installationId,
      runtime.storageKey,
    ) ?? runtime.descriptor.registration;
  const reference: UnifiedSearchReferenceV1 = {
    kind: 'external',
    registrationId: registration.registrationId,
    sourceId: normalized.sourceId,
  };
  const filters: UnifiedSearchFiltersV1 = {
    languages: projected.language ? [projected.language] : [],
    sourceRevisions: [normalized.sourceRevision],
    byKind: {},
  };
  const slot = projected.documentSlot ?? 'canonical';
  const id = await deriveSearchContractIdV1('document', {
    installationId: runtime.installationId,
    kind: runtime.storageKey,
    sourceId: normalized.sourceId,
    slot,
  });
  const segments: SearchProjectionSegmentV1[] = [
    {
      field: 'body',
      sourceId: normalized.sourceId,
      language: projected.language ?? null,
      text: projected.text,
      documentStart: 0,
      documentEnd: projected.text.length,
    },
  ];
  const authorization = {
    version: 1 as const,
    sourceKind: runtime.storageKey,
    sourceId: normalized.sourceId,
    sourceRevision: normalized.sourceRevision,
    installationId: runtime.installationId,
    workspaceId: null,
    ownerPrincipalId: runtime.ownerDomain,
    sourcePolicyRevision: normalized.sourcePolicyRevision,
    authorizationRevision: source.authorizationRevision,
    visibility: { version: 1 as const, clauses: [] },
    fingerprint: await canonicalSearchHashV1({
      registrationId: runtime.registrationId,
      sourcePolicyRevision: normalized.sourcePolicyRevision,
    }),
  };
  const documentWithoutHash = {
    version: 1 as const,
    projectionVersion: 'taproot-unified-search-projection-v1' as const,
    id,
    documentSlot: slot,
    kind: runtime.storageKey,
    source,
    rootReference: reference,
    canonicalReference: reference,
    authorization,
    filterMetadata: filters,
    text: projected.text,
    segments,
  };
  const document: DerivedSearchDocumentV1 = {
    ...documentWithoutHash,
    hash: await canonicalSearchHashV1(documentWithoutHash),
  };
  const chunks = await chunkDocument(document, maxChunkBytes);
  const planWithoutHash = {
    version: 1 as const,
    source,
    documents: [document],
    chunks,
    replaceAll: true as const,
    removeDocumentSlots: [] as string[],
  };
  return {
    ...planWithoutHash,
    id: await deriveSearchContractIdV1('plan', {
      eventId: source.eventId,
      fingerprint: runtime.descriptor.fingerprint,
    }),
    hash: await canonicalSearchHashV1(planWithoutHash),
  };
}

async function sealParticipant(
  runtime: RuntimeBinding,
  input: {
    sourceId: string;
    sourceRevision: string;
    predecessor: UnifiedSearchSourcePredecessorV1 | null;
    ownerMutationToken: unknown;
  },
): Promise<OwnerMutationParticipant> {
  const sourceId = token(input.sourceId, 'sourceId', 256);
  const sourceRevision = token(input.sourceRevision, 'sourceRevision', 128);
  const predecessor = normalizePredecessor(input.predecessor);
  const fence = await currentFence(runtime.db, runtime.installationId);
  const generation = fence.generation + 1;
  const eventId = `external-event-${await canonicalSearchHashV1({
    registrationId: runtime.registrationId,
    sourceId,
    sourceRevision,
    generation,
  })}`;
  const participant: OwnerMutationParticipant = Object.freeze({
    kind: 'taproot-owner-mutation-participant-v1' as const,
    ownerRegistrationId: runtime.registrationId,
    sourceId,
    sourceRevision,
    generation,
  });
  participantBindings.set(participant, {
    runtime,
    predecessor,
    ownerMutationToken: input.ownerMutationToken,
    eventId,
    status: 'fresh',
  });
  return participant;
}

async function commitParticipant(
  runtime: RuntimeBinding,
  participant: OwnerMutationParticipant,
): Promise<ExternalProducerMutationReceiptV1> {
  const binding = participantBindings.get(participant);
  if (
    !binding ||
    binding.runtime !== runtime ||
    participant.ownerRegistrationId !== runtime.registrationId ||
    binding.status !== 'fresh'
  )
    denied('owner mutation participant is invalid or consumed');
  binding.status = 'committing';
  const release = await acquireCommitLock(runtime);
  try {
    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
      const fence = await currentFence(runtime.db, runtime.installationId);
      if (participant.generation !== fence.generation + 1) {
        binding.status = 'failed';
        denied('owner mutation generation is stale');
      }
      const predecessor = await readPersistedSearchSourceRegistryV1(
        runtime.db,
        runtime.installationId,
        runtime.storageKey,
        participant.sourceId,
      );
      if (
        predecessor?.eventId !== binding.predecessor?.eventId ||
        predecessor?.sequence !== binding.predecessor?.sequence
      ) {
        binding.status = 'failed';
        denied('owner mutation predecessor is stale');
      }
      const prepared = await runtime.adapter.prepare(
        binding.ownerMutationToken,
      );
      const ownerStatements = normalizeOwnerStatements(prepared);
      const sourceHash = await canonicalSearchHashV1({
        registrationId: runtime.registrationId,
        sourceId: participant.sourceId,
        sourceRevision: participant.sourceRevision,
      });
      const now = runtime.clock().toISOString();
      const sourceEvent = await prepareUnifiedSearchSourceEventStatementsV1(
        runtime.db,
        {
          installationId: runtime.installationId,
          domain: runtime.ownerDomain,
          sourceKind: runtime.storageKey,
          sourcePolicyRevision: fence.authorizationRevision,
          authorizationRevision: fence.authorizationRevision,
          searchGeneration: participant.generation,
          createdAt: now,
        },
        {
          eventId: binding.eventId,
          sourceId: participant.sourceId,
          operation: 'upsert',
          changeClass: runtime.descriptor.changeClasses[0]!,
          sourceRevision: participant.sourceRevision,
          sourceHash,
          predecessor: binding.predecessor,
        },
        runtime.descriptor.changeClasses,
      );
      const advance = runtime.db
        .prepare(
          `UPDATE taproot_installation_authorization
           SET search_generation = ?, last_advance_id = ?, updated_at = ?
           WHERE installation_id = ? AND authorization_revision = ?
             AND search_generation = ? AND last_advance_id = ?`,
        )
        .bind(
          participant.generation,
          binding.eventId,
          now,
          runtime.installationId,
          fence.authorizationRevision,
          fence.generation,
          fence.lastAdvanceId,
        );
      try {
        const results = await runtime.db.batch([
          ...ownerStatements,
          ...sourceEvent.statements,
          advance,
        ]);
        const advanceResult = results.at(-1);
        if (Number(advanceResult?.meta?.changes ?? 0) !== 1) continue;
        binding.status = 'committed';
        return {
          eventId: binding.eventId,
          authorizationRevision: fence.authorizationRevision,
          generation: participant.generation,
          results: results.slice(0, ownerStatements.length),
        };
      } catch (cause) {
        const after = await currentFence(runtime.db, runtime.installationId);
        if (
          after.generation === fence.generation &&
          after.lastAdvanceId === fence.lastAdvanceId
        ) {
          binding.status = 'failed';
          throw cause;
        }
      }
    }
    binding.status = 'failed';
    denied('owner mutation generation contention exceeded the retry bound');
  } finally {
    release();
  }
}

async function adopt(
  runtime: RuntimeBinding,
  rawContext: AuthorizationContext,
  input: { cursor?: string | null; limit: number },
): Promise<{ enumerated: number; adopted: number; cursor: string | null }> {
  const context = normalizeAuthorizationContext(rawContext);
  if (
    context.installationId !== runtime.installationId ||
    !context.capabilities.includes('search:admin')
  )
    denied('search administration capability is required');
  const limit = integer(input.limit, 'limit', 1, 1000);
  const before = await currentFence(runtime.db, runtime.installationId);
  if (context.authorizationRevision !== before.authorizationRevision)
    denied('authorization fence is stale');
  const page = await runtime.producer.enumerate(input.cursor ?? null, limit);
  if (!page || !Array.isArray(page.ids))
    denied('external producer enumeration is invalid');
  const unique = [...new Set(page.ids.map((id) => token(id, 'sourceId', 256)))];
  if (unique.length !== page.ids.length || unique.length > limit)
    denied('external producer enumeration is invalid');
  let adopted = 0;
  for (const sourceId of unique) {
    const source = normalizeSource(await runtime.producer.loadExact(sourceId));
    if (source.sourceId !== sourceId)
      denied('external producer returned the wrong source');
    const predecessor = await readPersistedSearchSourceRegistryV1(
      runtime.db,
      runtime.installationId,
      runtime.storageKey,
      sourceId,
    );
    if (predecessor?.sourceRevision !== source.sourceRevision) {
      const sourceHash = await canonicalSearchHashV1({
        registrationId: runtime.registrationId,
        sourceId,
        sourceRevision: source.sourceRevision,
      });
      const eventId = `external-adoption-event-${await canonicalSearchHashV1({
        registrationId: runtime.registrationId,
        sourceId,
        sourceRevision: source.sourceRevision,
        predecessorEventId: predecessor?.eventId ?? null,
        authorizationRevision: before.authorizationRevision,
        searchGeneration: before.generation,
      })}`;
      const prepared = await prepareUnifiedSearchSourceEventStatementsV1(
        runtime.db,
        {
          installationId: runtime.installationId,
          domain: runtime.ownerDomain,
          sourceKind: runtime.storageKey,
          sourcePolicyRevision: source.sourcePolicyRevision,
          authorizationRevision: before.authorizationRevision,
          searchGeneration: before.generation,
          createdAt: runtime.clock().toISOString(),
        },
        {
          eventId,
          sourceId,
          operation: 'upsert',
          changeClass: runtime.descriptor.changeClasses[0]!,
          sourceRevision: source.sourceRevision,
          sourceHash,
          predecessor,
        },
        runtime.descriptor.changeClasses,
      );
      await runtime.db.batch(prepared.statements);
    }
    adopted += 1;
  }
  const after = await currentFence(runtime.db, runtime.installationId);
  if (
    after.authorizationRevision !== before.authorizationRevision ||
    after.generation !== before.generation
  )
    denied('authorization changed during external producer adoption');
  return {
    enumerated: unique.length,
    adopted,
    cursor: page.cursor === null ? null : token(page.cursor, 'cursor', 4096),
  };
}

async function persistDescriptor(runtime: RuntimeBinding): Promise<void> {
  const state = await currentFence(runtime.db, runtime.installationId);
  const now = runtime.clock().toISOString();
  const existing = await runtime.db
    .prepare(
      `SELECT producer_fingerprint, projection_version, contract_version,
              owning_domain
       FROM taproot_unified_search_producer_manifests
       WHERE installation_id = ? AND source_kind = ?
       ORDER BY manifest_revision DESC LIMIT 1`,
    )
    .bind(runtime.installationId, runtime.storageKey)
    .all<{
      producer_fingerprint: string;
      projection_version: string;
      contract_version: string;
      owning_domain: string;
    }>();
  const row = existing.results[0];
  if (row) {
    if (
      row.producer_fingerprint !== runtime.descriptor.fingerprint ||
      row.projection_version !== runtime.descriptor.projectionVersion ||
      row.contract_version !== runtime.descriptor.implementationVersion ||
      row.owning_domain !== runtime.ownerDomain
    )
      denied('external producer descriptor conflicts with durable state');
    await runtime.db
      .prepare(
        `INSERT INTO taproot_search_kind_checkpoints(
           corpus_id, source_kind, enqueued_sequence, applied_sequence
         )
         SELECT corpus_id, ?, 0, 0
         FROM taproot_search_corpora WHERE installation_id = ?
         ON CONFLICT(corpus_id, source_kind) DO NOTHING`,
      )
      .bind(runtime.storageKey, runtime.installationId)
      .run();
    return;
  }
  await runtime.db.batch([
    runtime.db
      .prepare(
        `INSERT INTO taproot_unified_search_producer_manifests(
           installation_id, source_kind, producer_fingerprint, owning_domain,
           contract_version, projection_version,
           authorization_contract_version, manifest_revision, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'taproot-context-authorization-v1', 1, ?)`,
      )
      .bind(
        runtime.installationId,
        runtime.storageKey,
        runtime.descriptor.fingerprint,
        runtime.ownerDomain,
        runtime.descriptor.implementationVersion,
        runtime.descriptor.projectionVersion,
        now,
      ),
    runtime.db
      .prepare(
        `INSERT INTO taproot_unified_search_producer_adoptions(
           installation_id, source_kind, producer_fingerprint, state,
           manifest_revision, updated_at
         ) VALUES (?, ?, ?, 'ready', 1, ?)
         ON CONFLICT(installation_id, source_kind) DO UPDATE SET
           producer_fingerprint=excluded.producer_fingerprint,
           state='ready', updated_at=excluded.updated_at`,
      )
      .bind(
        runtime.installationId,
        runtime.storageKey,
        runtime.descriptor.fingerprint,
        now,
      ),
    runtime.db
      .prepare(
        `INSERT INTO taproot_unified_search_generation_producers(
           corpus_id, installation_id, source_kind, producer_fingerprint,
           contract_version, projection_version,
           authorization_contract_version, state, updated_at
         )
         SELECT corpus_id, installation_id, ?, ?, ?, ?,
                'taproot-context-authorization-v1', 'ready', ?
         FROM taproot_search_corpora WHERE installation_id = ?
         ON CONFLICT(corpus_id, source_kind) DO UPDATE SET
           producer_fingerprint=excluded.producer_fingerprint,
           contract_version=excluded.contract_version,
           projection_version=excluded.projection_version,
           authorization_contract_version=excluded.authorization_contract_version,
           state='ready', updated_at=excluded.updated_at`,
      )
      .bind(
        runtime.storageKey,
        runtime.descriptor.fingerprint,
        runtime.descriptor.implementationVersion,
        runtime.descriptor.projectionVersion,
        now,
        runtime.installationId,
      ),
    runtime.db
      .prepare(
        `INSERT INTO taproot_search_kind_checkpoints(
           corpus_id, source_kind, enqueued_sequence, applied_sequence
         )
         SELECT corpus_id, ?, 0, 0
         FROM taproot_search_corpora WHERE installation_id = ?
         ON CONFLICT(corpus_id, source_kind) DO NOTHING`,
      )
      .bind(runtime.storageKey, runtime.installationId),
    runtime.db
      .prepare(
        `INSERT INTO taproot_unified_search_producer_admin_audit(
           audit_id, installation_id, source_kind, event_type,
           producer_fingerprint, manifest_revision, principal_id,
           details_json, created_at
         ) VALUES (?, ?, ?, 'register', ?, 1, ?, '{}', ?)`,
      )
      .bind(
        `producer-register-${runtime.registrationId}`,
        runtime.installationId,
        runtime.storageKey,
        runtime.descriptor.fingerprint,
        runtime.ownerDomain,
        now,
      ),
  ]);
  if (state.authorizationRevision < 1)
    denied('external producer installation is invalid');
}

function normalizeDescriptor(
  raw: ProducerDescriptor,
): Readonly<ProducerDescriptor> {
  const implementationVersion = token(
    raw.implementationVersion,
    'implementationVersion',
    128,
  );
  const projectionVersion = token(
    raw.projectionVersion,
    'projectionVersion',
    128,
  );
  const fingerprint = digest(raw.fingerprint, 'fingerprint');
  if (
    !Array.isArray(raw.changeClasses) ||
    raw.changeClasses.length === 0 ||
    raw.changeClasses.length > 32
  )
    denied('changeClasses is invalid');
  const changeClasses = [
    ...new Set(
      raw.changeClasses.map((value) => token(value, 'changeClass', 64)),
    ),
  ].sort();
  if (changeClasses.length !== raw.changeClasses.length)
    denied('changeClasses must be unique');
  return Object.freeze({
    registration: raw.registration,
    implementationVersion,
    fingerprint,
    projectionVersion,
    changeClasses: Object.freeze(changeClasses),
  });
}

function validateProducer(producer: ExternalProducer): void {
  if (
    !producer ||
    typeof producer.enumerate !== 'function' ||
    typeof producer.loadExact !== 'function' ||
    typeof producer.project !== 'function' ||
    typeof producer.authorize !== 'function' ||
    typeof producer.hydrate !== 'function' ||
    !producer.descriptor
  )
    denied('external producer is invalid');
}

function normalizeSource(raw: ProducerSource): ProducerSource {
  if (!raw || typeof raw !== 'object')
    denied('external producer source is invalid');
  return Object.freeze({
    sourceId: token(raw.sourceId, 'sourceId', 256),
    sourceRevision: token(raw.sourceRevision, 'sourceRevision', 128),
    sourcePolicyRevision: integer(
      raw.sourcePolicyRevision,
      'sourcePolicyRevision',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    canonical: raw.canonical,
  });
}

function normalizeProjectedDocument(
  raw: ExternalProjectedSearchDocumentV1,
): Required<Pick<ExternalProjectedSearchDocumentV1, 'text'>> &
  ExternalProjectedSearchDocumentV1 {
  if (!raw || typeof raw !== 'object') denied('external projection is invalid');
  const text = projectionText(raw.text);
  return Object.freeze({
    text,
    ...(raw.documentSlot === undefined
      ? {}
      : { documentSlot: token(raw.documentSlot, 'documentSlot', 128) }),
    ...(raw.title === undefined
      ? {}
      : { title: token(raw.title, 'title', 1024) }),
    ...(raw.language === undefined
      ? {}
      : { language: token(raw.language, 'language', 64) }),
    ...(raw.filters === undefined ? {} : { filters: raw.filters }),
  });
}

async function chunkDocument(
  document: DerivedSearchDocumentV1,
  rawMaximum: number,
): Promise<DerivedSearchChunkV1[]> {
  const maximum = integer(
    rawMaximum,
    'maxChunkBytes',
    UNIFIED_SEARCH_LIMITS.minChunkBytes,
    UNIFIED_SEARCH_LIMITS.maxChunkBytes,
  );
  const boundaries: Array<[number, number]> = [];
  let start = 0;
  let bytes = 0;
  let index = 0;
  for (const codePoint of document.text) {
    const size = encoder.encode(codePoint).byteLength;
    if (bytes > 0 && bytes + size > maximum) {
      boundaries.push([start, index]);
      start = index;
      bytes = 0;
    }
    bytes += size;
    index += codePoint.length;
  }
  if (index > start || boundaries.length === 0) boundaries.push([start, index]);
  if (boundaries.length > UNIFIED_SEARCH_LIMITS.maxChunksPerDocument)
    denied('external projection exceeds the chunk bound');
  const chunks: DerivedSearchChunkV1[] = [];
  for (const [ordinal, [documentStart, documentEnd]] of boundaries.entries()) {
    const text = document.text.slice(documentStart, documentEnd);
    const id = await deriveSearchContractIdV1('chunk', {
      documentId: document.id,
      ordinal,
    });
    const withoutHash = {
      version: 1 as const,
      id,
      documentId: document.id,
      ordinal,
      canonical: false as const,
      text,
      documentStart,
      documentEnd,
      trace: [
        {
          field: 'body' as const,
          sourceId: document.source.sourceId,
          language: document.segments[0]?.language ?? null,
          documentStart,
          documentEnd,
          chunkStart: 0,
          chunkEnd: text.length,
        },
      ],
    };
    chunks.push({
      ...withoutHash,
      hash: await canonicalSearchHashV1(withoutHash),
    });
  }
  return chunks;
}

function normalizeOwnerStatements(
  values: readonly unknown[],
): SqlitePreparedStatementLike[] {
  if (!Array.isArray(values) || values.length > MAX_OWNER_STATEMENTS)
    denied('owner mutation plan is invalid');
  return values.map((value) => {
    if (
      !value ||
      typeof value !== 'object' ||
      typeof (value as { run?: unknown }).run !== 'function' ||
      typeof (value as { bind?: unknown }).bind !== 'function'
    )
      denied('owner mutation plan is invalid');
    return value as SqlitePreparedStatementLike;
  });
}

function normalizePredecessor(
  raw: UnifiedSearchSourcePredecessorV1 | null,
): UnifiedSearchSourcePredecessorV1 | null {
  if (raw === null) return null;
  if (
    !raw ||
    typeof raw !== 'object' ||
    typeof raw.eventId !== 'string' ||
    !Number.isSafeInteger(raw.sequence) ||
    raw.sequence < 1
  )
    denied('predecessor is invalid');
  return Object.freeze({
    eventId: token(raw.eventId, 'predecessor.eventId', 128),
    sequence: raw.sequence,
  });
}

async function currentFence(
  db: D1DatabaseLike,
  installationId: string,
): Promise<{
  authorizationRevision: number;
  generation: number;
  lastAdvanceId: string;
}> {
  const result = await db
    .prepare(
      `SELECT authorization_revision, search_generation, last_advance_id
       FROM taproot_installation_authorization WHERE installation_id = ?`,
    )
    .bind(installationId)
    .all<{
      authorization_revision: number;
      search_generation: number;
      last_advance_id: string;
    }>();
  const row = result.results[0];
  if (!row) denied('external producer installation is unavailable');
  return {
    authorizationRevision: Number(row.authorization_revision),
    generation: Number(row.search_generation),
    lastAdvanceId: String(row.last_advance_id),
  };
}

async function acquireCommitLock(runtime: RuntimeBinding): Promise<() => void> {
  let byInstallation = commitLocks.get(runtime.db);
  if (!byInstallation) {
    byInstallation = new Map();
    commitLocks.set(runtime.db, byInstallation);
  }
  const previous =
    byInstallation.get(runtime.installationId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  byInstallation.set(runtime.installationId, queued);
  await previous;
  return () => {
    release();
    if (byInstallation?.get(runtime.installationId) === queued)
      byInstallation.delete(runtime.installationId);
  };
}

function runtimeKey(
  installationId: string,
  storageKey: string,
  fingerprint: string,
): string {
  return JSON.stringify([installationId, storageKey, fingerprint]);
}

function token(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    denied(`${field} is invalid`);
  return value;
}

function projectionText(value: unknown): string {
  if (typeof value !== 'string') denied('projection.text must be a string');
  const normalized = value.normalize('NFC');
  if (normalized.trim().length === 0)
    denied('projection.text must be nonblank');
  if (
    encoder.encode(normalized).byteLength >
    UNIFIED_SEARCH_LIMITS.maxProjectionTextBytes
  )
    denied('projection.text is too large');
  return normalized;
}

function digest(value: unknown, field: string): string {
  const normalized = token(value, field, 64);
  if (!/^[0-9a-f]{64}$/u.test(normalized)) denied(`${field} is invalid`);
  return normalized;
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    denied(`${field} is invalid`);
  return value;
}

function denied(message: string): never {
  throw new InvalidAuthorizationError(message);
}
