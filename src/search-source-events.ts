import type {
  SqliteDatabaseLike,
  SqlitePreparedStatementLike,
  SqliteResultLike,
} from '@gnolith/diamond';
import {
  InvalidSearchSourceEventError,
  SearchSourceReplayConflictError,
} from './errors.js';

export const UNIFIED_SEARCH_SOURCE_KINDS_V1 = [
  'statement',
  'item',
  'task',
  'memory',
  'prompt',
  'resource',
  'annotation',
] as const;

export type UnifiedSearchSourceKindV1 =
  (typeof UNIFIED_SEARCH_SOURCE_KINDS_V1)[number];
export type UnifiedSearchSourceOperationV1 = 'upsert' | 'delete';

export interface UnifiedSearchSourcePredecessorV1 {
  eventId: string;
  sequence: number;
}

export interface UnifiedSearchSourceEventInputV1 {
  eventId: string;
  sourceId: string;
  operation: UnifiedSearchSourceOperationV1;
  changeClass: string;
  sourceRevision: string;
  sourceHash: string;
  predecessor: UnifiedSearchSourcePredecessorV1 | null;
}

export interface InstallationSearchSourceBindingV1 {
  domain: string;
  sourceKind: UnifiedSearchSourceKindV1;
  capability: string;
  changeClasses: readonly string[];
}

export interface InstallationSearchSourceEventReceiptV1 {
  eventId: string;
  authorizationRevision: number;
  searchGeneration: number;
  replayed: boolean;
  results: readonly SqliteResultLike[];
}

export interface InstallationSearchSourceGuardV1 {
  readonly kind: 'taproot-installation-search-source-guard-v1';
  batchWithSourceEvent(
    context: import('./types.js').AuthorizationContext,
    event: UnifiedSearchSourceEventInputV1,
    statements: readonly SqlitePreparedStatementLike[],
  ): Promise<InstallationSearchSourceEventReceiptV1>;
}

export interface PersistedSearchSourceRegistryV1 {
  eventId: string;
  sequence: number;
  domain: string;
  sourceRevision: string;
  payloadHash: string;
  sourcePolicyRevision: number;
  authorizationRevision: number;
  searchGeneration: number;
}

export interface PreparedSearchSourceEventV1 {
  event: Readonly<UnifiedSearchSourceEventInputV1>;
  payloadHash: string;
  statements: readonly SqlitePreparedStatementLike[];
}

export function normalizeInstallationSearchSourceBindingV1(
  raw: InstallationSearchSourceBindingV1,
): Readonly<InstallationSearchSourceBindingV1> {
  exactKeys(raw, ['capability', 'changeClasses', 'domain', 'sourceKind']);
  const sourceKind = sourceKindV1(raw.sourceKind);
  const changeClasses = stringArray(raw.changeClasses, 'changeClasses', 32, 64);
  if (changeClasses.length === 0)
    invalid('changeClasses must contain at least one value');
  return Object.freeze({
    domain: token(raw.domain, 'domain', 64),
    sourceKind,
    capability: token(raw.capability, 'capability', 128),
    changeClasses: Object.freeze(changeClasses),
  });
}

export function normalizeUnifiedSearchSourceEventInputV1(
  raw: UnifiedSearchSourceEventInputV1,
  binding: Pick<InstallationSearchSourceBindingV1, 'changeClasses'>,
): Readonly<UnifiedSearchSourceEventInputV1> {
  exactKeys(raw, [
    'changeClass',
    'eventId',
    'operation',
    'predecessor',
    'sourceHash',
    'sourceId',
    'sourceRevision',
  ]);
  const changeClass = token(raw.changeClass, 'changeClass', 64);
  if (!binding.changeClasses.includes(changeClass))
    invalid('changeClass is not owned by this guard');
  if (raw.operation !== 'upsert' && raw.operation !== 'delete')
    invalid('operation is invalid');
  const predecessor = normalizePredecessor(raw.predecessor);
  return Object.freeze({
    eventId: token(raw.eventId, 'eventId', 128),
    sourceId: token(raw.sourceId, 'sourceId', 256),
    operation: raw.operation,
    changeClass,
    sourceRevision: token(raw.sourceRevision, 'sourceRevision', 128),
    sourceHash: digest(raw.sourceHash, 'sourceHash'),
    predecessor,
  });
}

export async function unifiedSearchSourcePayloadHashV1(
  installationId: string,
  domain: string,
  sourceKind: UnifiedSearchSourceKindV1,
  event: Readonly<UnifiedSearchSourceEventInputV1>,
  sourcePolicyRevision: number,
  authorizationRevision: number,
  searchGeneration: number,
): Promise<string> {
  const payload = JSON.stringify([
    'taproot-unified-search-source-event-v1',
    installationId,
    domain,
    sourceKind,
    event.eventId,
    event.sourceId,
    event.operation,
    event.changeClass,
    event.sourceRevision,
    event.sourceHash,
    sourcePolicyRevision,
    authorizationRevision,
    searchGeneration,
    event.predecessor?.eventId ?? null,
    event.predecessor?.sequence ?? null,
  ]);
  const value = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(payload),
  );
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function readPersistedSearchSourceRegistryV1(
  db: SqliteDatabaseLike,
  installationId: string,
  sourceKind: UnifiedSearchSourceKindV1,
  sourceId: string,
): Promise<PersistedSearchSourceRegistryV1 | null> {
  const result = await db
    .prepare(
      `SELECT domain, current_event_id, current_event_sequence, source_revision,
              payload_hash, source_policy_revision, authorization_revision,
              search_generation
       FROM taproot_unified_search_source_registry
       WHERE installation_id = ? AND source_kind = ? AND source_id = ?`,
    )
    .bind(installationId, sourceKind, sourceId)
    .all<{
      domain: string;
      current_event_id: string;
      current_event_sequence: number;
      source_revision: string;
      payload_hash: string;
      source_policy_revision: number;
      authorization_revision: number;
      search_generation: number;
    }>();
  const row = result.results[0];
  return row
    ? {
        eventId: row.current_event_id,
        sequence: Number(row.current_event_sequence),
        domain: row.domain,
        sourceRevision: row.source_revision,
        payloadHash: row.payload_hash,
        sourcePolicyRevision: Number(row.source_policy_revision),
        authorizationRevision: Number(row.authorization_revision),
        searchGeneration: Number(row.search_generation),
      }
    : null;
}

export async function inspectUnifiedSearchSourceReplayV1(
  db: SqliteDatabaseLike,
  installationId: string,
  sourceKind: UnifiedSearchSourceKindV1,
  sourceId: string,
  sourceRevision: string,
): Promise<{
  eventId: string;
  payloadHash: string;
  sourcePolicyRevision: number;
  authorizationRevision: number;
  searchGeneration: number;
} | null> {
  const result = await db
    .prepare(
      `SELECT event_id, payload_hash, source_policy_revision,
              authorization_revision, search_generation
       FROM taproot_unified_search_source_events
       WHERE installation_id = ? AND source_kind = ? AND source_id = ?
         AND source_revision = ?`,
    )
    .bind(installationId, sourceKind, sourceId, sourceRevision)
    .all<{
      event_id: string;
      payload_hash: string;
      source_policy_revision: number;
      authorization_revision: number;
      search_generation: number;
    }>();
  const row = result.results[0];
  return row
    ? {
        eventId: row.event_id,
        payloadHash: row.payload_hash,
        sourcePolicyRevision: Number(row.source_policy_revision),
        authorizationRevision: Number(row.authorization_revision),
        searchGeneration: Number(row.search_generation),
      }
    : null;
}

export async function prepareUnifiedSearchSourceEventStatementsV1(
  db: SqliteDatabaseLike,
  authority: {
    installationId: string;
    domain: string;
    sourceKind: UnifiedSearchSourceKindV1;
    sourcePolicyRevision: number;
    authorizationRevision: number;
    searchGeneration: number;
    createdAt: string;
  },
  rawEvent: UnifiedSearchSourceEventInputV1,
  changeClasses: readonly string[],
): Promise<PreparedSearchSourceEventV1> {
  const event = normalizeUnifiedSearchSourceEventInputV1(rawEvent, {
    changeClasses,
  });
  const payloadHash = await unifiedSearchSourcePayloadHashV1(
    authority.installationId,
    authority.domain,
    authority.sourceKind,
    event,
    authority.sourcePolicyRevision,
    authority.authorizationRevision,
    authority.searchGeneration,
  );
  const predecessorEventId = event.predecessor?.eventId ?? null;
  const predecessorSequence = event.predecessor?.sequence ?? null;
  const statements = [
    db
      .prepare(
        `INSERT INTO taproot_unified_search_source_events(
           event_id, installation_id, domain, source_kind, source_id,
           operation, change_class, source_revision, source_hash,
           source_policy_revision, authorization_revision, search_generation, predecessor_event_id,
           predecessor_sequence, payload_hash, created_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (? IS NULL AND NOT EXISTS (
           SELECT 1 FROM taproot_unified_search_source_registry
           WHERE installation_id = ? AND source_kind = ? AND source_id = ?
         )) OR EXISTS (
           SELECT 1 FROM taproot_unified_search_source_registry
           WHERE installation_id = ? AND source_kind = ? AND source_id = ?
             AND domain = ? AND current_event_id = ? AND current_event_sequence = ?
         )`,
      )
      .bind(
        event.eventId,
        authority.installationId,
        authority.domain,
        authority.sourceKind,
        event.sourceId,
        event.operation,
        event.changeClass,
        event.sourceRevision,
        event.sourceHash,
        authority.sourcePolicyRevision,
        authority.authorizationRevision,
        authority.searchGeneration,
        predecessorEventId,
        predecessorSequence,
        payloadHash,
        authority.createdAt,
        predecessorEventId,
        authority.installationId,
        authority.sourceKind,
        event.sourceId,
        authority.installationId,
        authority.sourceKind,
        event.sourceId,
        authority.domain,
        predecessorEventId,
        predecessorSequence,
      ),
    db
      .prepare(
        `INSERT INTO taproot_unified_search_source_registry(
           installation_id, source_kind, source_id, domain, current_event_id,
           current_event_sequence, operation, change_class, source_revision,
           source_hash, source_policy_revision, authorization_revision,
           search_generation, payload_hash, updated_at
         ) SELECT ?, ?, ?, ?, e.event_id, e.sequence, ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM taproot_unified_search_source_events e WHERE e.event_id = ?
         ON CONFLICT(installation_id, source_kind, source_id) DO UPDATE SET
           current_event_id = excluded.current_event_id,
           current_event_sequence = excluded.current_event_sequence,
           operation = excluded.operation,
           change_class = excluded.change_class,
           source_revision = excluded.source_revision,
           source_hash = excluded.source_hash,
           source_policy_revision = excluded.source_policy_revision,
           authorization_revision = excluded.authorization_revision,
           search_generation = excluded.search_generation,
           payload_hash = excluded.payload_hash,
           updated_at = excluded.updated_at
         WHERE taproot_unified_search_source_registry.domain = excluded.domain
           AND taproot_unified_search_source_registry.current_event_id IS ?
           AND taproot_unified_search_source_registry.current_event_sequence IS ?`,
      )
      .bind(
        authority.installationId,
        authority.sourceKind,
        event.sourceId,
        authority.domain,
        event.operation,
        event.changeClass,
        event.sourceRevision,
        event.sourceHash,
        authority.sourcePolicyRevision,
        authority.authorizationRevision,
        authority.searchGeneration,
        payloadHash,
        authority.createdAt,
        event.eventId,
        predecessorEventId,
        predecessorSequence,
      ),
    db
      .prepare(
        `INSERT INTO taproot_assertions(assertion_key)
         SELECT NULL WHERE NOT EXISTS (
           SELECT 1 FROM taproot_unified_search_source_registry
           WHERE installation_id = ? AND source_kind = ? AND source_id = ?
             AND domain = ? AND current_event_id = ? AND source_revision = ?
             AND source_policy_revision = ?
             AND authorization_revision = ? AND search_generation = ?
             AND payload_hash = ?
         )`,
      )
      .bind(
        authority.installationId,
        authority.sourceKind,
        event.sourceId,
        authority.domain,
        event.eventId,
        event.sourceRevision,
        authority.sourcePolicyRevision,
        authority.authorizationRevision,
        authority.searchGeneration,
        payloadHash,
      ),
    db
      .prepare(
        `UPDATE taproot_search_materialization_heads
         SET eligible = 0, updated_at = ?
         WHERE root_kind = ? AND root_id = ?
           AND source_event_sequence < (
             SELECT sequence FROM taproot_unified_search_source_events
             WHERE event_id = ?
           )
           AND corpus_id IN (
             SELECT active_corpus_id FROM taproot_search_installation_state
             WHERE installation_id = ?
             UNION
             SELECT shadow_corpus_id FROM taproot_search_installation_state
             WHERE installation_id = ? AND shadow_corpus_id IS NOT NULL
           )`,
      )
      .bind(
        authority.createdAt,
        authority.sourceKind,
        event.sourceId,
        event.eventId,
        authority.installationId,
        authority.installationId,
      ),
    db
      .prepare(
        `UPDATE taproot_search_corpora
         SET state = 'building', ready_at = NULL
         WHERE corpus_id IN (
           SELECT shadow_corpus_id FROM taproot_search_installation_state
           WHERE installation_id = ? AND shadow_corpus_id IS NOT NULL
         ) AND role = 'shadow' AND state = 'ready'`,
      )
      .bind(authority.installationId),
    db
      .prepare(
        `INSERT INTO taproot_search_projection_jobs(
           job_id, corpus_id, installation_id, source_event_id,
           source_event_sequence, source_kind, source_id, operation,
           root_revision, root_hash, source_policy_revision,
           authorization_revision, search_generation, producer_fingerprint,
           state, not_before, created_at, updated_at
         )
         SELECT c.corpus_id || ':' || e.event_id, c.corpus_id,
           e.installation_id, e.event_id, e.sequence, e.source_kind,
           e.source_id, e.operation, e.source_revision, e.source_hash,
           e.source_policy_revision, e.authorization_revision,
           e.search_generation, p.producer_fingerprint, 'pending',
           e.created_at, e.created_at, e.created_at
         FROM taproot_unified_search_source_events e
         JOIN taproot_search_installation_state s
           ON s.installation_id = e.installation_id
         JOIN taproot_search_corpora c
           ON c.corpus_id = s.active_corpus_id
             OR c.corpus_id = s.shadow_corpus_id
         JOIN taproot_unified_search_generation_producers p
           ON p.corpus_id = c.corpus_id AND p.installation_id = e.installation_id
          AND p.source_kind = e.source_kind AND p.state = 'ready'
         WHERE e.event_id = ?
         ON CONFLICT(corpus_id, source_event_id) DO NOTHING`,
      )
      .bind(event.eventId),
    db
      .prepare(
        `INSERT INTO taproot_search_job_transitions(
           transition_id, job_id, from_state, to_state, attempt, created_at
         )
         SELECT job_id || ':pending', job_id, NULL, 'pending', 0, created_at
         FROM taproot_search_projection_jobs
         WHERE source_event_id = ? AND installation_id = ?
         ON CONFLICT(transition_id) DO NOTHING`,
      )
      .bind(event.eventId, authority.installationId),
    db
      .prepare(
        `UPDATE taproot_search_kind_checkpoints
         SET enqueued_sequence = MAX(enqueued_sequence, (
           SELECT sequence FROM taproot_unified_search_source_events
           WHERE event_id = ?
         ))
         WHERE source_kind = ? AND corpus_id IN (
           SELECT active_corpus_id FROM taproot_search_installation_state
           WHERE installation_id = ?
           UNION
           SELECT shadow_corpus_id FROM taproot_search_installation_state
           WHERE installation_id = ? AND shadow_corpus_id IS NOT NULL
         )`,
      )
      .bind(
        event.eventId,
        authority.sourceKind,
        authority.installationId,
        authority.installationId,
      ),
  ] as const;
  return Object.freeze({
    event,
    payloadHash,
    statements: Object.freeze(statements),
  });
}

export function assertExactSearchSourceReplayV1(
  existing: { eventId: string; payloadHash: string },
  eventId: string,
  payloadHash: string,
): void {
  if (existing.eventId !== eventId || existing.payloadHash !== payloadHash)
    throw new SearchSourceReplayConflictError(
      'unified-search source revision replay diverges from the immutable event',
    );
}

function normalizePredecessor(
  value: UnifiedSearchSourcePredecessorV1 | null,
): Readonly<UnifiedSearchSourcePredecessorV1> | null {
  if (value === null) return null;
  exactKeys(value, ['eventId', 'sequence']);
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1)
    invalid('predecessor.sequence is invalid');
  return Object.freeze({
    eventId: token(value.eventId, 'predecessor.eventId', 128),
    sequence: value.sequence,
  });
}

function sourceKindV1(value: unknown): UnifiedSearchSourceKindV1 {
  if (!UNIFIED_SEARCH_SOURCE_KINDS_V1.includes(value as never))
    invalid('sourceKind is invalid');
  return value as UnifiedSearchSourceKindV1;
}

function digest(value: unknown, field: string): string {
  const normalized = token(value, field, 64);
  if (!/^[a-f0-9]{64}$/u.test(normalized)) invalid(`${field} is invalid`);
  return normalized;
}

function token(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    value !== value.normalize('NFC') ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  )
    invalid(`${field} is invalid`);
  return value;
}

function stringArray(
  value: unknown,
  field: string,
  maximumItems: number,
  maximumLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems)
    invalid(`${field} is invalid`);
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid(`${field} is invalid`);
    result.push(token(value[index], field, maximumLength));
  }
  if (new Set(result).size !== result.length) invalid(`${field} is invalid`);
  return result;
}

function exactKeys(value: unknown, expected: readonly string[]): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...expected].sort())
  )
    invalid('unified-search source value has invalid fields');
}

function invalid(message: string): never {
  throw new InvalidSearchSourceEventError(message);
}
