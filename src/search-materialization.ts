import type {
  D1DatabaseLike,
  SqlitePreparedStatementLike,
} from '@gnolith/diamond';
import {
  PersistedEntityAuthorizationSource,
  SEARCH_ADMIN_CAPABILITY,
  normalizeAuthorizationContext,
} from './authorization.js';
import { parseEntityJson } from './canonical.js';
import { InvalidAuthorizationError } from './errors.js';
import {
  UNIFIED_SEARCH_KINDS,
  UNIFIED_SEARCH_LIMITS,
  canonicalSearchHashV1,
  createSearchProjectionAuthorizationAuthorityV1,
  createTrustedSearchAuthorizationEnvelopeV1,
  projectItemForUnifiedSearchV1,
  projectResourceForUnifiedSearchV1,
  projectAnnotationForUnifiedSearchV1,
  type DerivedSearchDocumentV1,
  type SearchProjectionPlanV1,
  type SearchProjectionSourceEventV1,
  type UnifiedSearchKind,
} from './search-contract.js';
import type {
  AuthorizationContext,
  Item,
  VisibilityAtomV1,
  VisibilityScopeV1,
} from './types.js';
import {
  buildExternalSearchProjectionPlanInternalV1,
  lookupExternalSearchProducerRuntimeInternalV1,
} from './external-search-producers.js';
import type { PortableResourcePayloadStoreV1 } from './content-domain.js';

const MAX_RUN_JOBS = 100;
const MAX_REBUILD_ROOTS = 100;
const MAX_SQL_BATCH = 50;
const MAX_ATTEMPTS = 5;
const BUILTIN_SEARCH_KINDS = [
  'statement',
  'item',
  'resource',
  'annotation',
] as const;

export interface SearchMaterializationRunOptionsV1 {
  maxJobs: number;
  maxRebuildRoots: number;
  maxChunkBytes?: number;
  leaseMilliseconds?: number;
}

export interface SearchMaterializationRunReceiptV1 {
  claimed: number;
  completed: number;
  superseded: number;
  deferred: number;
  dead: number;
  rebuildRootsEnumerated: number;
}

export interface SearchMaterializationHealthV1 {
  version: 1;
  status: 'blocked' | 'building' | 'degraded';
  activeCorpusGeneration: number;
  shadowCorpusGeneration: number | null;
  cursorGeneration: number;
  blockedProducerKinds: readonly UnifiedSearchKind[];
  pendingJobs: number;
  leasedJobs: number;
  deadJobs: number;
  staleHeads: number;
  sourceHighWatermark: number;
  activeAppliedWatermark: number;
  shadowAppliedWatermark: number | null;
  lastErrorCode: string | null;
}

export interface SearchMaterializationAdminGuardV1 {
  readonly kind: 'taproot-search-materialization-admin-v1';
  initialize(context: AuthorizationContext): Promise<void>;
  run(
    context: AuthorizationContext,
    options: SearchMaterializationRunOptionsV1,
  ): Promise<SearchMaterializationRunReceiptV1>;
  health(context: AuthorizationContext): Promise<SearchMaterializationHealthV1>;
  retryDead(
    context: AuthorizationContext,
    options: { limit: number },
  ): Promise<number>;
  startShadowRebuild(context: AuthorizationContext): Promise<number>;
  activateReadyShadow(context: AuthorizationContext): Promise<number>;
}

interface RuntimeOptions {
  db: D1DatabaseLike;
  installationId: string;
  clock: () => Date;
  payloadStore?: PortableResourcePayloadStoreV1;
  maxExternalPayloadBytes?: number;
}

export interface SearchMaterializationContentOptionsV1 {
  payloadStore?: PortableResourcePayloadStoreV1;
  maxExternalPayloadBytes?: number;
}

interface JobRow {
  job_id: string;
  corpus_id: string;
  source_event_id: string;
  source_event_sequence: number;
  source_kind: UnifiedSearchKind;
  source_id: string;
  operation: 'upsert' | 'delete';
  root_revision: string;
  root_hash: string;
  source_policy_revision: number;
  authorization_revision: number;
  search_generation: number;
  producer_fingerprint: string | null;
  state: 'pending' | 'leased' | 'staged' | 'complete' | 'dead';
  attempt: number;
  claim_generation: number;
  claim_token: string | null;
  lease_expires_at: string | null;
}

interface Claim {
  job: JobRow;
  token: string;
  generation: number;
  expiresAt: string;
}

export function createSearchMaterializationRuntimeV1(
  options: RuntimeOptions,
): SearchMaterializationAdminGuardV1 {
  const runtime = new SearchMaterializationRuntime(options);
  return Object.freeze({
    kind: 'taproot-search-materialization-admin-v1' as const,
    initialize: (context: AuthorizationContext) => runtime.initialize(context),
    run: (
      context: AuthorizationContext,
      runOptions: SearchMaterializationRunOptionsV1,
    ) => runtime.run(context, runOptions),
    health: (context: AuthorizationContext) => runtime.health(context),
    retryDead: (
      context: AuthorizationContext,
      retryOptions: { limit: number },
    ) => runtime.retryDead(context, retryOptions),
    startShadowRebuild: (context: AuthorizationContext) =>
      runtime.startShadowRebuild(context),
    activateReadyShadow: (context: AuthorizationContext) =>
      runtime.activateReadyShadow(context),
  });
}

class SearchMaterializationRuntime {
  readonly #db: D1DatabaseLike;
  readonly #installationId: string;
  readonly #clock: () => Date;
  readonly #payloadStore: PortableResourcePayloadStoreV1 | undefined;
  readonly #maxExternalPayloadBytes: number;

  constructor(options: RuntimeOptions) {
    this.#db = options.db;
    this.#installationId = options.installationId;
    this.#clock = options.clock;
    this.#payloadStore = options.payloadStore;
    this.#maxExternalPayloadBytes =
      options.maxExternalPayloadBytes ?? 8 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.#maxExternalPayloadBytes) ||
      this.#maxExternalPayloadBytes < 65_536 ||
      this.#maxExternalPayloadBytes > 64 * 1024 * 1024
    )
      throw new Error('maxExternalPayloadBytes is invalid');
  }

  async initialize(rawContext: AuthorizationContext): Promise<void> {
    const context = await this.#authorize(rawContext);
    const existing = await this.#state();
    if (existing) return;
    const now = this.#now();
    const corpusId = await stableId('corpus', {
      installationId: this.#installationId,
      generation: 1,
    });
    const auditId = await stableId('audit', {
      installationId: this.#installationId,
      event: 'initialize',
      corpusId,
    });
    const sourceHighWatermark = await this.#sourceHighWatermark();
    const statements: SqlitePreparedStatementLike[] = [
      ...BUILTIN_SEARCH_KINDS.map((kind) =>
        this.#db
          .prepare(
            `INSERT INTO taproot_unified_search_producer_manifests(
               installation_id, source_kind, producer_fingerprint,
               owning_domain, contract_version, projection_version,
               authorization_contract_version, manifest_revision, created_at
             ) VALUES (?, ?, 'taproot-builtin-projection-v1', 'taproot',
               'taproot-external-search-producer-v1',
               'taproot-unified-search-projection-v1',
               'taproot-search-authorization-v1', 1, ?)
             ON CONFLICT(installation_id, source_kind, producer_fingerprint)
             DO NOTHING`,
          )
          .bind(this.#installationId, kind, now),
      ),
      ...UNIFIED_SEARCH_KINDS.map((kind) =>
        this.#db
          .prepare(
            `INSERT INTO taproot_unified_search_producer_adoptions(
               installation_id, source_kind, producer_fingerprint, state,
               manifest_revision, updated_at)
             VALUES (?, ?, ?, ?, 1, ?)
             ON CONFLICT(installation_id, source_kind) DO NOTHING`,
          )
          .bind(
            this.#installationId,
            kind,
            BUILTIN_SEARCH_KINDS.includes(
              kind as (typeof BUILTIN_SEARCH_KINDS)[number],
            )
              ? 'taproot-builtin-projection-v1'
              : null,
            BUILTIN_SEARCH_KINDS.includes(
              kind as (typeof BUILTIN_SEARCH_KINDS)[number],
            )
              ? 'ready'
              : 'blocked',
            now,
          ),
      ),
      this.#db
        .prepare(
          `INSERT INTO taproot_search_corpora(
             corpus_id, installation_id, corpus_generation, role, state,
             source_watermark_sequence, fanout_start_sequence,
             enumeration_complete, created_at, activated_at
           ) VALUES (?, ?, 1, 'active', 'active', ?, ?, 0, ?, ?)`,
        )
        .bind(
          corpusId,
          this.#installationId,
          sourceHighWatermark,
          sourceHighWatermark,
          now,
          now,
        ),
      this.#db
        .prepare(
          `INSERT INTO taproot_search_installation_state(
             installation_id, active_corpus_id, cursor_generation,
             lifecycle_generation, health_code, blocked_producer_count,
             created_at, updated_at
           ) VALUES (?, ?, 1, 1, 'blocked-producers', 3, ?, ?)`,
        )
        .bind(this.#installationId, corpusId, now, now),
      ...UNIFIED_SEARCH_KINDS.map((kind) =>
        this.#db
          .prepare(
            `INSERT INTO taproot_search_kind_checkpoints(
               corpus_id, source_kind, enqueued_sequence, applied_sequence
             ) VALUES (?, ?, 0, 0)`,
          )
          .bind(corpusId, kind),
      ),
      this.#db
        .prepare(
          `INSERT INTO taproot_unified_search_generation_producers(
             corpus_id, installation_id, source_kind, producer_fingerprint,
             contract_version, projection_version,
             authorization_contract_version, state, updated_at
           )
           SELECT ?, a.installation_id, a.source_kind, a.producer_fingerprint,
             m.contract_version, m.projection_version,
             m.authorization_contract_version,
             CASE WHEN a.state = 'ready' AND m.producer_fingerprint IS NOT NULL
               THEN 'ready' ELSE 'blocked' END, ?
           FROM taproot_unified_search_producer_adoptions a
           LEFT JOIN taproot_unified_search_producer_manifests m
             ON m.installation_id = a.installation_id
            AND m.source_kind = a.source_kind
            AND m.producer_fingerprint = a.producer_fingerprint
           WHERE a.installation_id = ?`,
        )
        .bind(corpusId, now, this.#installationId),
      this.#db
        .prepare(
          `INSERT INTO taproot_search_admin_audit(
             audit_id, installation_id, event_type, principal_id,
             corpus_id, details_json, created_at
           ) VALUES (?, ?, 'initialize', ?, ?, ?, ?)`,
        )
        .bind(
          auditId,
          this.#installationId,
          context.principalId,
          corpusId,
          JSON.stringify({ version: 1, sourceHighWatermark }),
          now,
        ),
    ];
    await this.#db.batch(statements);
  }

  async run(
    rawContext: AuthorizationContext,
    rawOptions: SearchMaterializationRunOptionsV1,
  ): Promise<SearchMaterializationRunReceiptV1> {
    await this.#authorize(rawContext);
    const options = normalizeRunOptions(rawOptions);
    const state = await this.#requiredState();
    let rebuildRootsEnumerated = await this.#enumerateCorpusPage(
      state.active_corpus_id,
      options.maxRebuildRoots,
    );
    if (state.shadow_corpus_id) {
      const remainingEnumerationBudget =
        options.maxRebuildRoots - rebuildRootsEnumerated;
      if (remainingEnumerationBudget > 0) {
        rebuildRootsEnumerated += await this.#enumerateCorpusPage(
          state.shadow_corpus_id,
          remainingEnumerationBudget,
        );
      }
    }
    const claims = await this.#claimPage(
      options.maxJobs,
      options.leaseMilliseconds,
    );
    const receipt: SearchMaterializationRunReceiptV1 = {
      claimed: claims.length,
      completed: 0,
      superseded: 0,
      deferred: 0,
      dead: 0,
      rebuildRootsEnumerated,
    };
    for (const claim of claims) {
      try {
        const outcome = await this.#processClaim(claim, options.maxChunkBytes);
        receipt[outcome] += 1;
      } catch {
        const outcome = await this.#deferOrDead(claim, 'projection-failed');
        receipt[outcome] += 1;
      }
    }
    if (state.shadow_corpus_id)
      await this.#refreshShadowReadiness(state.shadow_corpus_id);
    return receipt;
  }

  async health(
    rawContext: AuthorizationContext,
  ): Promise<SearchMaterializationHealthV1> {
    await this.#authorize(rawContext);
    const state = await this.#requiredState();
    const high = await this.#sourceHighWatermark();
    const counts = await this.#db
      .prepare(
        `SELECT
           SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN state IN ('leased', 'staged') THEN 1 ELSE 0 END) AS leased,
           SUM(CASE WHEN state = 'dead' THEN 1 ELSE 0 END) AS dead
         FROM taproot_search_projection_jobs WHERE installation_id = ?`,
      )
      .bind(this.#installationId)
      .all<{ pending: number; leased: number; dead: number }>();
    const stale = await this.#db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM taproot_search_materialization_heads h
         JOIN taproot_search_installation_state s
           ON s.installation_id = ? AND h.corpus_id = s.active_corpus_id
         LEFT JOIN taproot_unified_search_source_registry r
           ON r.installation_id = s.installation_id
          AND r.source_kind = h.root_kind AND r.source_id = h.root_id
         WHERE h.eligible = 0 OR r.current_event_sequence IS NULL
            OR r.current_event_sequence != h.source_event_sequence`,
      )
      .bind(this.#installationId)
      .all<{ count: number }>();
    const generations = await this.#db
      .prepare(
        `SELECT a.corpus_generation AS active_generation,
                COALESCE(MAX(ac.applied_sequence), 0) AS active_applied,
                sh.corpus_generation AS shadow_generation,
                COALESCE(MAX(sc.applied_sequence), 0) AS shadow_applied
         FROM taproot_search_installation_state s
         JOIN taproot_search_corpora a ON a.corpus_id = s.active_corpus_id
         LEFT JOIN taproot_search_kind_checkpoints ac ON ac.corpus_id = a.corpus_id
         LEFT JOIN taproot_search_corpora sh ON sh.corpus_id = s.shadow_corpus_id
         LEFT JOIN taproot_search_kind_checkpoints sc ON sc.corpus_id = sh.corpus_id
         WHERE s.installation_id = ?
         GROUP BY a.corpus_generation, sh.corpus_generation`,
      )
      .bind(this.#installationId)
      .all<{
        active_generation: number;
        active_applied: number;
        shadow_generation: number | null;
        shadow_applied: number | null;
      }>();
    const countRow = counts.results[0];
    const generation = generations.results[0]!;
    const blockedProducerKinds = await this.#blockedProducerKinds(
      state.active_corpus_id,
    );
    return {
      version: 1,
      status:
        state.shadow_corpus_id !== null
          ? 'building'
          : Number(countRow?.dead ?? 0) > 0
            ? 'degraded'
            : 'blocked',
      activeCorpusGeneration: Number(generation.active_generation),
      shadowCorpusGeneration:
        generation.shadow_generation === null
          ? null
          : Number(generation.shadow_generation),
      cursorGeneration: Number(state.cursor_generation),
      blockedProducerKinds,
      pendingJobs: Number(countRow?.pending ?? 0),
      leasedJobs: Number(countRow?.leased ?? 0),
      deadJobs: Number(countRow?.dead ?? 0),
      staleHeads: Number(stale.results[0]?.count ?? 0),
      sourceHighWatermark: high,
      activeAppliedWatermark: Number(generation.active_applied),
      shadowAppliedWatermark:
        generation.shadow_generation === null
          ? null
          : Number(generation.shadow_applied ?? 0),
      lastErrorCode: state.last_error_code,
    };
  }

  async retryDead(
    rawContext: AuthorizationContext,
    options: { limit: number },
  ): Promise<number> {
    const context = await this.#authorize(rawContext);
    const limit = boundedInteger(options?.limit, 'limit', 1, MAX_RUN_JOBS);
    const now = this.#now();
    const rows = await this.#db
      .prepare(
        `SELECT job_id FROM taproot_search_projection_jobs
         WHERE installation_id = ? AND state = 'dead'
         ORDER BY source_event_sequence LIMIT ?`,
      )
      .bind(this.#installationId, limit)
      .all<{ job_id: string }>();
    const state = await this.#requiredState();
    let retried = 0;
    for (const row of rows.results) {
      const transitionId = await stableId('transition', {
        jobId: row.job_id,
        event: 'retry',
        now,
        nonce: randomToken128(),
      });
      const auditId = await stableId('audit', {
        event: 'retry',
        transitionId,
      });
      await this.#db.batch([
        this.#db
          .prepare(
            `INSERT INTO taproot_search_job_transitions(
               transition_id, job_id, from_state, to_state, attempt, created_at
             )
             SELECT ?, job_id, state, 'pending', 0, ?
             FROM taproot_search_projection_jobs
             WHERE job_id = ? AND state = 'dead'`,
          )
          .bind(transitionId, now, row.job_id),
        this.#db
          .prepare(
            `UPDATE taproot_search_projection_jobs
             SET state = 'pending', attempt = 0, last_error_code = NULL,
                 not_before = ?, updated_at = ? WHERE job_id = ? AND state = 'dead'`,
          )
          .bind(now, now, row.job_id),
        this.#db
          .prepare(
            `INSERT INTO taproot_assertions(assertion_key)
             SELECT NULL WHERE NOT EXISTS (
               SELECT 1 FROM taproot_search_projection_jobs j
               JOIN taproot_search_job_transitions t ON t.job_id = j.job_id
               WHERE j.job_id = ? AND j.state = 'pending'
                 AND j.attempt = 0 AND t.transition_id = ?
             )`,
          )
          .bind(row.job_id, transitionId),
        this.#db
          .prepare(
            `INSERT INTO taproot_search_admin_audit(
               audit_id, installation_id, event_type, principal_id,
               corpus_id, details_json, created_at
             ) VALUES (?, ?, 'retry', ?, ?, ?, ?)`,
          )
          .bind(
            auditId,
            this.#installationId,
            context.principalId,
            state.active_corpus_id,
            JSON.stringify({ version: 1, count: 1, transitionId }),
            now,
          ),
      ]);
      retried += 1;
    }
    return retried;
  }

  async startShadowRebuild(rawContext: AuthorizationContext): Promise<number> {
    const context = await this.#authorize(rawContext);
    const state = await this.#requiredState();
    if (state.shadow_corpus_id)
      throw new InvalidAuthorizationError('search rebuild is already active');
    const current = await this.#db
      .prepare(
        `SELECT corpus_generation FROM taproot_search_corpora WHERE corpus_id = ?`,
      )
      .bind(state.active_corpus_id)
      .all<{ corpus_generation: number }>();
    const generation = Number(current.results[0]?.corpus_generation) + 1;
    const corpusId = await stableId('corpus', {
      installationId: this.#installationId,
      generation,
    });
    const watermark = await this.#sourceHighWatermark();
    const now = this.#now();
    const auditId = await stableId('audit', {
      event: 'rebuild-start',
      corpusId,
      watermark,
    });
    await this.#db.batch([
      this.#db
        .prepare(
          `INSERT INTO taproot_search_corpora(
             corpus_id, installation_id, corpus_generation, role, state,
             source_watermark_sequence, fanout_start_sequence,
             enumeration_complete, created_at
           ) VALUES (?, ?, ?, 'shadow', 'building', ?, ?, 0, ?)`,
        )
        .bind(
          corpusId,
          this.#installationId,
          generation,
          watermark,
          watermark,
          now,
        ),
      ...UNIFIED_SEARCH_KINDS.map((kind) =>
        this.#db
          .prepare(
            `INSERT INTO taproot_search_kind_checkpoints(
               corpus_id, source_kind, enqueued_sequence, applied_sequence
             ) VALUES (?, ?, 0, 0)`,
          )
          .bind(corpusId, kind),
      ),
      this.#db
        .prepare(
          `INSERT INTO taproot_unified_search_generation_producers(
             corpus_id, installation_id, source_kind, producer_fingerprint,
             contract_version, projection_version,
             authorization_contract_version, state, updated_at
           )
           SELECT ?, a.installation_id, a.source_kind, a.producer_fingerprint,
             m.contract_version, m.projection_version,
             m.authorization_contract_version,
             CASE WHEN a.state = 'ready' AND m.producer_fingerprint IS NOT NULL
               THEN 'ready' ELSE 'blocked' END, ?
           FROM taproot_unified_search_producer_adoptions a
           LEFT JOIN taproot_unified_search_producer_manifests m
             ON m.installation_id = a.installation_id
            AND m.source_kind = a.source_kind
            AND m.producer_fingerprint = a.producer_fingerprint
           WHERE a.installation_id = ?`,
        )
        .bind(corpusId, now, this.#installationId),
      this.#db
        .prepare(
          `UPDATE taproot_search_installation_state
           SET shadow_corpus_id = ?, lifecycle_generation = lifecycle_generation + 1,
               health_code = 'building', updated_at = ?
           WHERE installation_id = ? AND shadow_corpus_id IS NULL`,
        )
        .bind(corpusId, now, this.#installationId),
      this.#db
        .prepare(
          `INSERT INTO taproot_search_admin_audit(
             audit_id, installation_id, event_type, principal_id,
             corpus_id, details_json, created_at
           ) VALUES (?, ?, 'rebuild-start', ?, ?, ?, ?)`,
        )
        .bind(
          auditId,
          this.#installationId,
          context.principalId,
          corpusId,
          JSON.stringify({ version: 1, watermark }),
          now,
        ),
    ]);
    return generation;
  }

  async activateReadyShadow(rawContext: AuthorizationContext): Promise<number> {
    const context = await this.#authorize(rawContext);
    const state = await this.#requiredState();
    if (!state.shadow_corpus_id)
      throw new InvalidAuthorizationError('search rebuild is not active');
    await this.#refreshShadowReadiness(state.shadow_corpus_id);
    const corpus = await this.#db
      .prepare(
        `SELECT corpus_generation, state, source_watermark_sequence
         FROM taproot_search_corpora
         WHERE corpus_id = ?`,
      )
      .bind(state.shadow_corpus_id)
      .all<{
        corpus_generation: number;
        state: string;
        source_watermark_sequence: number;
      }>();
    if (corpus.results[0]?.state !== 'ready')
      throw new InvalidAuthorizationError('search rebuild is not ready');
    const watermark = Number(corpus.results[0].source_watermark_sequence);
    const now = this.#now();
    const nextCursor = Number(state.cursor_generation) + 1;
    const auditId = await stableId('audit', {
      event: 'activate',
      corpusId: state.shadow_corpus_id,
      watermark,
      nextCursor,
    });
    await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE taproot_search_installation_state
           SET active_corpus_id = shadow_corpus_id, shadow_corpus_id = NULL,
               cursor_generation = ?, lifecycle_generation = lifecycle_generation + 1,
               health_code = 'blocked-producers', updated_at = ?
           WHERE installation_id = ? AND active_corpus_id = ?
             AND shadow_corpus_id = ? AND EXISTS (
               SELECT 1 FROM taproot_search_corpora c
               WHERE c.corpus_id = ? AND c.state = 'ready'
                 AND c.enumeration_complete = 1
                 AND c.source_watermark_sequence = ?
             ) AND NOT EXISTS (
               SELECT 1 FROM taproot_search_projection_jobs
               WHERE corpus_id = ? AND state != 'complete'
             ) AND NOT EXISTS (
               SELECT 1
               FROM taproot_unified_search_source_registry r
               LEFT JOIN taproot_search_materialization_heads h
                 ON h.corpus_id = ? AND h.root_kind = r.source_kind
                AND h.root_id = r.source_id
               WHERE r.installation_id = ?
                 AND r.source_kind != 'statement'
                 AND (h.source_event_sequence IS NULL
                   OR h.source_event_sequence != r.current_event_sequence)
             ) AND NOT EXISTS (
               SELECT 1 FROM taproot_unified_search_source_events
               WHERE installation_id = ? AND sequence > ?
             )`,
        )
        .bind(
          nextCursor,
          now,
          this.#installationId,
          state.active_corpus_id,
          state.shadow_corpus_id,
          state.shadow_corpus_id,
          watermark,
          state.shadow_corpus_id,
          state.shadow_corpus_id,
          this.#installationId,
          this.#installationId,
          watermark,
        ),
      this.#db
        .prepare(
          `INSERT INTO taproot_assertions(assertion_key)
           SELECT NULL WHERE NOT EXISTS (
             SELECT 1 FROM taproot_search_installation_state
             WHERE installation_id = ? AND active_corpus_id = ?
               AND shadow_corpus_id IS NULL AND cursor_generation = ?
           )`,
        )
        .bind(this.#installationId, state.shadow_corpus_id, nextCursor),
      this.#db
        .prepare(
          `UPDATE taproot_search_corpora SET role = 'retired', state = 'retired'
           WHERE corpus_id = ?`,
        )
        .bind(state.active_corpus_id),
      this.#db
        .prepare(
          `UPDATE taproot_search_corpora
           SET role = 'active', state = 'active', activated_at = ?
           WHERE corpus_id = ? AND state = 'ready'`,
        )
        .bind(now, state.shadow_corpus_id),
      this.#db
        .prepare(
          `INSERT INTO taproot_search_admin_audit(
             audit_id, installation_id, event_type, principal_id,
             corpus_id, details_json, created_at
           ) VALUES (?, ?, 'activate', ?, ?, ?, ?)`,
        )
        .bind(
          auditId,
          this.#installationId,
          context.principalId,
          state.shadow_corpus_id,
          JSON.stringify({
            version: 1,
            watermark,
            cursorGeneration: nextCursor,
          }),
          now,
        ),
    ]);
    return Number(corpus.results[0]?.corpus_generation);
  }

  async #claimPage(limit: number, leaseMilliseconds: number): Promise<Claim[]> {
    const now = this.#now();
    const leaseExpires = new Date(
      new Date(now).getTime() + leaseMilliseconds,
    ).toISOString();
    const pending = await this.#db
      .prepare(
        `SELECT * FROM taproot_search_projection_jobs
         WHERE installation_id = ? AND state = 'pending' AND not_before <= ?
         ORDER BY not_before, source_event_sequence, corpus_id LIMIT ?`,
      )
      .bind(this.#installationId, now, limit)
      .all<JobRow>();
    const expiredLeased = await this.#db
      .prepare(
        `SELECT * FROM taproot_search_projection_jobs
         WHERE installation_id = ? AND state = 'leased'
           AND lease_expires_at <= ?
         ORDER BY lease_expires_at, source_event_sequence, corpus_id LIMIT ?`,
      )
      .bind(this.#installationId, now, limit)
      .all<JobRow>();
    const expiredStaged = await this.#db
      .prepare(
        `SELECT * FROM taproot_search_projection_jobs
         WHERE installation_id = ? AND state = 'staged'
           AND lease_expires_at <= ?
         ORDER BY lease_expires_at, source_event_sequence, corpus_id LIMIT ?`,
      )
      .bind(this.#installationId, now, limit)
      .all<JobRow>();
    const candidates = [
      ...pending.results,
      ...expiredLeased.results,
      ...expiredStaged.results,
    ]
      .sort(
        (left, right) =>
          Number(left.source_event_sequence) -
            Number(right.source_event_sequence) ||
          left.corpus_id.localeCompare(right.corpus_id),
      )
      .filter((job) => this.#producerAvailable(job))
      .slice(0, limit);
    const claims: Claim[] = [];
    for (const observed of candidates) {
      const token = randomToken128();
      const generation = Number(observed.claim_generation) + 1;
      const attempt = Number(observed.attempt) + 1;
      const transitionId = `${observed.job_id}:lease:${generation}`;
      const tokenHash = await sha256(token);
      try {
        await this.#db.batch([
          this.#db
            .prepare(
              `UPDATE taproot_search_projection_jobs
               SET state = 'leased', attempt = ?, claim_token = ?,
                   claim_generation = ?, lease_expires_at = ?, updated_at = ?
               WHERE job_id = ? AND claim_generation = ? AND (
                 (state = 'pending' AND not_before <= ?)
                 OR (state IN ('leased', 'staged') AND lease_expires_at <= ?)
               )`,
            )
            .bind(
              attempt,
              token,
              generation,
              leaseExpires,
              now,
              observed.job_id,
              observed.claim_generation,
              now,
              now,
            ),
          this.#db
            .prepare(
              `INSERT INTO taproot_assertions(assertion_key)
               SELECT NULL WHERE NOT EXISTS (
                 SELECT 1 FROM taproot_search_projection_jobs
                 WHERE job_id = ? AND state = 'leased'
                   AND claim_token = ? AND claim_generation = ?
               )`,
            )
            .bind(observed.job_id, token, generation),
          this.#db
            .prepare(
              `INSERT INTO taproot_search_job_transitions(
                 transition_id, job_id, from_state, to_state,
                 claim_token_hash, attempt, created_at
               ) VALUES (?, ?, ?, 'leased', ?, ?, ?)`,
            )
            .bind(
              transitionId,
              observed.job_id,
              observed.state,
              tokenHash,
              attempt,
              now,
            ),
        ]);
        claims.push({
          job: { ...observed, attempt, claim_generation: generation },
          token,
          generation,
          expiresAt: leaseExpires,
        });
      } catch {
        // Another bounded runner won the CAS.
      }
    }
    return claims;
  }

  #producerAvailable(job: JobRow): boolean {
    if (
      BUILTIN_SEARCH_KINDS.includes(
        job.source_kind as (typeof BUILTIN_SEARCH_KINDS)[number],
      ) &&
      job.producer_fingerprint === 'taproot-builtin-projection-v1'
    )
      return true;
    return (
      lookupExternalSearchProducerRuntimeInternalV1(
        this.#db,
        this.#installationId,
        job.source_kind,
        job.producer_fingerprint,
      ) !== null
    );
  }

  async #blockedProducerKinds(
    corpusId: string,
  ): Promise<readonly UnifiedSearchKind[]> {
    const result = await this.#db
      .prepare(
        `SELECT source_kind, producer_fingerprint, state
         FROM taproot_unified_search_generation_producers
         WHERE corpus_id = ? ORDER BY source_kind`,
      )
      .bind(corpusId)
      .all<{
        source_kind: UnifiedSearchKind;
        producer_fingerprint: string | null;
        state: 'ready' | 'blocked' | 'retired';
      }>();
    const byKind = new Map(result.results.map((row) => [row.source_kind, row]));
    return UNIFIED_SEARCH_KINDS.filter((kind) => {
      const row = byKind.get(kind);
      if (!row || row.state !== 'ready') return true;
      if (
        BUILTIN_SEARCH_KINDS.includes(
          kind as (typeof BUILTIN_SEARCH_KINDS)[number],
        ) &&
        row.producer_fingerprint === 'taproot-builtin-projection-v1'
      )
        return false;
      return (
        lookupExternalSearchProducerRuntimeInternalV1(
          this.#db,
          this.#installationId,
          kind,
          row.producer_fingerprint,
        ) === null
      );
    });
  }

  async #processClaim(
    claim: Claim,
    maxChunkBytes: number,
  ): Promise<'completed' | 'superseded' | 'deferred' | 'dead'> {
    const current = await this.#currentRegistry(claim.job);
    if (!current) {
      await this.#completeSuperseded(claim, 'stale-source-event');
      return 'superseded';
    }
    if (claim.job.source_kind === 'statement') {
      await this.#completeSuperseded(claim, 'item-root-owned');
      return 'superseded';
    }
    const plan =
      claim.job.operation === 'delete'
        ? await emptyPlan(claim.job, this.#installationId)
        : claim.job.source_kind === 'item'
          ? await this.#loadAndProjectItem(claim.job, maxChunkBytes)
          : claim.job.source_kind === 'resource' ||
              claim.job.source_kind === 'annotation'
            ? await this.#loadAndProjectContent(claim.job, maxChunkBytes)
            : await this.#loadAndProjectExternal(claim.job, maxChunkBytes);
    if (!plan) {
      await this.#completeSuperseded(claim, 'canonical-state-stale');
      return 'superseded';
    }
    const stageId = await stableId('stage', {
      jobId: claim.job.job_id,
      claimGeneration: claim.generation,
    });
    await this.#persistInvisibleStage(claim, stageId, plan);
    if (!(await this.#currentRegistry(claim.job))) {
      await this.#completeSuperseded(claim, 'source-advanced');
      return 'superseded';
    }
    await this.#finalizeStage(claim, stageId, plan);
    return 'completed';
  }

  async #loadAndProjectExternal(
    job: JobRow,
    maxChunkBytes: number,
  ): Promise<SearchProjectionPlanV1 | null> {
    const runtime = lookupExternalSearchProducerRuntimeInternalV1(
      this.#db,
      this.#installationId,
      job.source_kind,
      job.producer_fingerprint,
    );
    if (!runtime) return null;
    const loaded = await runtime.callbacks.loadCurrent({
      sourceId: job.source_id,
      expectedSourceRevision: job.root_revision,
    });
    if (!loaded) return null;
    return buildExternalSearchProjectionPlanInternalV1(
      runtime,
      loaded,
      projectionSource(job, this.#installationId),
      maxChunkBytes,
    );
  }

  async #loadAndProjectItem(
    job: JobRow,
    maxChunkBytes: number,
  ): Promise<SearchProjectionPlanV1 | null> {
    if (job.source_kind !== 'item') return null;
    const root = await this.#db
      .prepare(
        `SELECT e.entity_json, e.revision, e.deleted_at, e.redirect_to,
                r.content_hash, p.workspace_id, p.owner_principal_id,
                p.effective_visibility_json, p.authorization_revision
         FROM taproot_entities e
         JOIN taproot_entity_revisions r
           ON r.entity_id = e.entity_id AND r.revision = e.revision
         JOIN taproot_entity_authorization p
           ON p.entity_id = e.entity_id AND p.source_revision = e.revision
         WHERE e.entity_id = ? AND p.installation_id = ?`,
      )
      .bind(job.source_id, this.#installationId)
      .all<{
        entity_json: string;
        revision: number;
        deleted_at: string | null;
        redirect_to: string | null;
        content_hash: string;
        workspace_id: string | null;
        owner_principal_id: string;
        effective_visibility_json: string;
        authorization_revision: number;
      }>();
    const row = root.results[0];
    if (
      !row ||
      row.deleted_at !== null ||
      row.redirect_to !== null ||
      String(row.revision) !== job.root_revision ||
      row.content_hash !== job.root_hash ||
      Number(row.authorization_revision) !== job.source_policy_revision
    )
      return null;
    const entity = parseEntityJson(row.entity_json);
    if (entity.type !== 'item') return null;
    const statementPolicies = await this.#db
      .prepare(
        `SELECT statement_id, effective_visibility_json, authorization_revision
         FROM taproot_statement_authorization
         WHERE entity_id = ? AND source_revision = ? ORDER BY statement_id`,
      )
      .bind(entity.id, entity.lastrevid)
      .all<{
        statement_id: string;
        effective_visibility_json: string;
        authorization_revision: number;
      }>();
    const source = projectionSource(job, this.#installationId);
    const authority = createSearchProjectionAuthorizationAuthorityV1(
      new PersistedEntityAuthorizationSource(this.#db),
    );
    const itemAuthorization = await createTrustedSearchAuthorizationEnvelopeV1(
      authority,
      {
        version: 1,
        sourceKind: 'item',
        sourceId: entity.id,
        sourceRevision: job.root_revision,
        installationId: this.#installationId,
        workspaceId: row.workspace_id,
        ownerPrincipalId: row.owner_principal_id,
        sourcePolicyRevision: job.source_policy_revision,
        authorizationRevision: job.authorization_revision,
        visibility: JSON.parse(
          row.effective_visibility_json,
        ) as VisibilityScopeV1,
      },
    );
    const byId = new Map(
      statementPolicies.results.map((policy) => [policy.statement_id, policy]),
    );
    const statementAuthorizations: Record<
      string,
      Awaited<ReturnType<typeof createTrustedSearchAuthorizationEnvelopeV1>>
    > = {};
    for (const statement of allStatements(entity)) {
      const policy = byId.get(statement.id);
      if (
        !policy ||
        Number(policy.authorization_revision) !== job.source_policy_revision
      )
        return null;
      statementAuthorizations[statement.id] =
        await createTrustedSearchAuthorizationEnvelopeV1(authority, {
          version: 1,
          sourceKind: 'statement',
          sourceId: statement.id,
          sourceRevision: job.root_revision,
          installationId: this.#installationId,
          workspaceId: row.workspace_id,
          ownerPrincipalId: row.owner_principal_id,
          sourcePolicyRevision: job.source_policy_revision,
          authorizationRevision: job.authorization_revision,
          visibility: JSON.parse(
            policy.effective_visibility_json,
          ) as VisibilityScopeV1,
        });
    }
    return projectItemForUnifiedSearchV1({
      source,
      item: entity,
      authorization: itemAuthorization,
      statementAuthorizations,
      mixedScope: 'partition',
      maxChunkBytes,
    });
  }

  async #loadAndProjectContent(
    job: JobRow,
    maxChunkBytes: number,
  ): Promise<SearchProjectionPlanV1 | null> {
    if (job.source_kind !== 'resource' && job.source_kind !== 'annotation')
      return null;
    const table =
      job.source_kind === 'resource'
        ? 'taproot_resources'
        : 'taproot_annotations';
    const result = await this.#db
      .prepare(
        `SELECT record_json, revision, policy_revision, visibility_json, deleted_at FROM ${table} WHERE record_id = ? AND installation_id = ?`,
      )
      .bind(job.source_id, this.#installationId)
      .all<{
        record_json: string;
        revision: number;
        policy_revision: number;
        visibility_json: string;
        deleted_at: string | null;
      }>();
    const row = result.results[0];
    if (
      !row ||
      row.deleted_at !== null ||
      String(row.revision) !== job.root_revision ||
      Number(row.policy_revision) !== job.source_policy_revision ||
      (await canonicalSearchHashV1(JSON.parse(row.record_json))) !==
        job.root_hash
    )
      return null;
    const record = JSON.parse(row.record_json) as {
      id: string;
      title?: string;
      payload?: {
        kind: string;
        text?: string;
        location?: string;
        storage?: 'blob' | 'file' | 'url';
        byteLength?: number;
      };
      integrity?: { algorithm: string; digest: string; byteLength: number };
      mediaType?: string;
      language?: string;
      body?: { kind: string; text?: string; resourceId?: string };
      authorization: { workspaceId: string | null; ownerPrincipalId: string };
    };
    let text =
      job.source_kind === 'resource'
        ? record.payload?.kind === 'inline-text'
          ? record.payload.text
          : (record.title ?? record.payload?.location)
        : record.body?.kind === 'text'
          ? record.body.text
          : undefined;
    if (
      job.source_kind === 'resource' &&
      record.payload?.kind === 'location' &&
      this.#payloadStore &&
      isTextualMediaType(record.mediaType ?? 'application/octet-stream')
    ) {
      const bytes = await this.#payloadStore.load(
        record.payload as Parameters<PortableResourcePayloadStoreV1['load']>[0],
      );
      if (bytes.byteLength > this.#maxExternalPayloadBytes)
        throw new Error(
          'external resource payload exceeds materialization bound',
        );
      if (
        !record.integrity ||
        record.integrity.algorithm !== 'sha256' ||
        record.integrity.byteLength !== bytes.byteLength ||
        (await sha256Bytes(bytes)) !== record.integrity.digest
      )
        throw new Error('external resource payload integrity mismatch');
      text = [
        record.title,
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ]
        .filter(Boolean)
        .join('\n');
    }
    if (job.source_kind === 'annotation' && !text && record.body?.resourceId) {
      const body = await this.#db
        .prepare(
          `SELECT record_json FROM taproot_resources WHERE record_id = ? AND installation_id = ? AND deleted_at IS NULL`,
        )
        .bind(record.body.resourceId, this.#installationId)
        .all<{ record_json: string }>();
      const resource = body.results[0]
        ? (JSON.parse(body.results[0].record_json) as {
            payload?: { kind: string; text?: string };
            title?: string;
          })
        : undefined;
      text =
        resource?.payload?.kind === 'inline-text'
          ? resource.payload.text
          : resource?.title;
    }
    if (!text) return null;
    const source = projectionSource(job, this.#installationId);
    const authority = createSearchProjectionAuthorizationAuthorityV1(
      new PersistedEntityAuthorizationSource(this.#db),
    );
    const authorization = await createTrustedSearchAuthorizationEnvelopeV1(
      authority,
      {
        version: 1,
        sourceKind: job.source_kind,
        sourceId: job.source_id,
        sourceRevision: job.root_revision,
        installationId: this.#installationId,
        workspaceId: record.authorization.workspaceId,
        ownerPrincipalId: record.authorization.ownerPrincipalId,
        sourcePolicyRevision: job.source_policy_revision,
        authorizationRevision: job.authorization_revision,
        visibility: JSON.parse(row.visibility_json) as VisibilityScopeV1,
      },
    );
    return job.source_kind === 'resource'
      ? projectResourceForUnifiedSearchV1({
          source,
          resourceId: job.source_id,
          ...(record.title === undefined ? {} : { title: record.title }),
          text,
          ...(record.language === undefined
            ? {}
            : { language: record.language }),
          mediaType: record.mediaType ?? 'application/octet-stream',
          authorization,
          maxChunkBytes,
        })
      : projectAnnotationForUnifiedSearchV1({
          source,
          annotationId: job.source_id,
          text,
          ...(record.language === undefined
            ? {}
            : { language: record.language }),
          authorization,
          maxChunkBytes,
        });
  }

  async #persistInvisibleStage(
    claim: Claim,
    stageId: string,
    plan: SearchProjectionPlanV1,
  ): Promise<void> {
    const now = this.#now();
    await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE taproot_search_stages SET state = 'abandoned'
           WHERE job_id = ? AND state != 'committed'`,
        )
        .bind(claim.job.job_id),
      this.#db
        .prepare(
          `INSERT INTO taproot_search_stages(
             stage_id, job_id, corpus_id, claim_token, claim_generation,
             state, root_kind, root_id, source_event_id,
             source_event_sequence, root_revision, root_hash,
             source_policy_revision, authorization_revision,
             producer_fingerprint, created_at
           ) VALUES (?, ?, ?, ?, ?, 'building', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          stageId,
          claim.job.job_id,
          claim.job.corpus_id,
          claim.token,
          claim.generation,
          claim.job.source_kind,
          claim.job.source_id,
          claim.job.source_event_id,
          claim.job.source_event_sequence,
          claim.job.root_revision,
          claim.job.root_hash,
          claim.job.source_policy_revision,
          claim.job.authorization_revision,
          claim.job.producer_fingerprint,
          now,
        ),
    ]);
    for (const [pageOrdinal, documents] of [
      ...pages(plan.documents, 25),
    ].entries()) {
      const pageStatements: SqlitePreparedStatementLike[] = [];
      for (const document of documents)
        pageStatements.push(
          ...this.#documentStatements(stageId, document, plan),
        );
      for (const batch of pages(pageStatements, MAX_SQL_BATCH))
        await this.#db.batch(batch);
      const pageChunks = plan.chunks.filter((chunk) =>
        documents.some(({ id }) => id === chunk.documentId),
      );
      const pageHash = await canonicalSearchHashV1({
        documentHashes: documents.map(({ hash }) => hash),
        chunkHashes: pageChunks.map(({ hash }) => hash),
      });
      await this.#db
        .prepare(
          `INSERT INTO taproot_search_stage_pages(
             stage_id, page_ordinal, first_document_slot, last_document_slot,
             document_count, chunk_count, page_hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          stageId,
          pageOrdinal,
          documents[0]!.documentSlot,
          documents.at(-1)!.documentSlot,
          documents.length,
          pageChunks.length,
          pageHash,
        )
        .run();
    }
    const manifestHash = await canonicalSearchHashV1({
      planHash: plan.hash,
      documentHashes: plan.documents.map(({ hash }) => hash),
      chunkHashes: plan.chunks.map(({ hash }) => hash),
    });
    const counts = await this.#db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM taproot_search_staged_documents WHERE stage_id = ?) AS documents,
           (SELECT COUNT(*) FROM taproot_search_chunks WHERE stage_id = ?) AS chunks,
           (SELECT COUNT(*) FROM taproot_search_stage_pages WHERE stage_id = ?) AS pages`,
      )
      .bind(stageId, stageId, stageId)
      .all<{ documents: number; chunks: number; pages: number }>();
    const observed = counts.results[0]!;
    if (
      Number(observed.documents) !== plan.documents.length ||
      Number(observed.chunks) !== plan.chunks.length
    )
      throw new Error('search stage manifest mismatch');
    await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE taproot_search_stages SET state = 'verified', manifest_hash = ?,
             page_count = ?, document_count = ?, chunk_count = ?, verified_at = ?
           WHERE stage_id = ? AND state = 'building'`,
        )
        .bind(
          manifestHash,
          observed.pages,
          observed.documents,
          observed.chunks,
          now,
          stageId,
        ),
      this.#db
        .prepare(
          `UPDATE taproot_search_projection_jobs SET state = 'staged', updated_at = ?
           WHERE job_id = ? AND state = 'leased' AND claim_token = ?
             AND claim_generation = ?`,
        )
        .bind(now, claim.job.job_id, claim.token, claim.generation),
      this.#db
        .prepare(
          `INSERT INTO taproot_assertions(assertion_key)
           SELECT NULL WHERE NOT EXISTS (
             SELECT 1 FROM taproot_search_projection_jobs
             WHERE job_id = ? AND state = 'staged' AND claim_token = ?
               AND claim_generation = ?
           )`,
        )
        .bind(claim.job.job_id, claim.token, claim.generation),
    ]);
  }

  #documentStatements(
    stageId: string,
    document: DerivedSearchDocumentV1,
    plan: SearchProjectionPlanV1,
  ): SqlitePreparedStatementLike[] {
    const statements: SqlitePreparedStatementLike[] = [
      this.#db
        .prepare(
          `INSERT INTO taproot_search_staged_documents(
             stage_id, document_slot, document_id, document_hash,
             document_kind, root_reference_json, canonical_reference_json,
             authorization_fingerprint, filter_metadata_json, document_text
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          stageId,
          document.documentSlot,
          document.id,
          document.hash,
          document.kind,
          JSON.stringify(document.rootReference),
          JSON.stringify(document.canonicalReference),
          document.authorization.fingerprint,
          JSON.stringify(document.filterMetadata),
          document.text,
        ),
    ];
    for (const [
      clauseOrdinal,
      clause,
    ] of document.authorization.visibility.clauses.entries()) {
      statements.push(
        this.#db
          .prepare(
            `INSERT INTO taproot_search_document_clauses(
               stage_id, document_slot, clause_ordinal
             ) VALUES (?, ?, ?)`,
          )
          .bind(stageId, document.documentSlot, clauseOrdinal),
      );
      for (const [atomOrdinal, atom] of clause.entries()) {
        const normalized = visibilityAtom(atom);
        statements.push(
          this.#db
            .prepare(
              `INSERT INTO taproot_search_document_atoms(
                 stage_id, document_slot, clause_ordinal, atom_ordinal,
                 atom_kind, atom_value
               ) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              stageId,
              document.documentSlot,
              clauseOrdinal,
              atomOrdinal,
              normalized.kind,
              normalized.value,
            ),
        );
      }
    }
    for (const [name, value] of filterValues(document))
      statements.push(
        this.#db
          .prepare(
            `INSERT INTO taproot_search_filter_values(
               stage_id, document_slot, filter_name, filter_value
             ) VALUES (?, ?, ?, ?)`,
          )
          .bind(stageId, document.documentSlot, name, value),
      );
    for (const chunk of plan.chunks.filter(
      ({ documentId }) => documentId === document.id,
    )) {
      validateChunkFence(document, chunk);
      statements.push(
        this.#db
          .prepare(
            `INSERT INTO taproot_search_chunks(
               stage_id, document_slot, chunk_id, chunk_hash, ordinal,
               document_start, document_end, chunk_text, trace_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            stageId,
            document.documentSlot,
            chunk.id,
            chunk.hash,
            chunk.ordinal,
            chunk.documentStart,
            chunk.documentEnd,
            chunk.text,
            JSON.stringify(chunk.trace),
          ),
      );
    }
    return statements;
  }

  async #finalizeStage(
    claim: Claim,
    stageId: string,
    plan: SearchProjectionPlanV1,
  ): Promise<void> {
    const now = this.#now();
    const eligible =
      claim.job.operation === 'upsert' && plan.documents.length > 0 ? 1 : 0;
    const prior = await this.#db
      .prepare(
        `SELECT current_stage_id FROM taproot_search_materialization_heads
         WHERE corpus_id = ? AND root_kind = ? AND root_id = ?`,
      )
      .bind(claim.job.corpus_id, claim.job.source_kind, claim.job.source_id)
      .all<{ current_stage_id: string }>();
    const transitionId = `${claim.job.job_id}:complete:${claim.generation}`;
    const statements: SqlitePreparedStatementLike[] = [
      this.#db
        .prepare(
          `INSERT INTO taproot_assertions(assertion_key)
           SELECT NULL WHERE NOT EXISTS (
             SELECT 1 FROM taproot_unified_search_source_registry
             WHERE installation_id = ? AND source_kind = ? AND source_id = ?
               AND current_event_id = ? AND current_event_sequence = ?
               AND operation = ? AND source_revision = ? AND source_hash = ?
               AND authorization_revision = ? AND search_generation = ?
           )`,
        )
        .bind(
          this.#installationId,
          claim.job.source_kind,
          claim.job.source_id,
          claim.job.source_event_id,
          claim.job.source_event_sequence,
          claim.job.operation,
          claim.job.root_revision,
          claim.job.root_hash,
          claim.job.authorization_revision,
          claim.job.search_generation,
        ),
    ];
    if (prior.results[0]) {
      statements.push(
        this.#db
          .prepare(
            `INSERT INTO taproot_search_materialization_tombstones(
               tombstone_id, corpus_id, root_kind, root_id, removed_stage_id,
               source_event_id, source_event_sequence, reason, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            await stableId('tombstone', {
              corpusId: claim.job.corpus_id,
              rootKind: claim.job.source_kind,
              rootId: claim.job.source_id,
              eventSequence: claim.job.source_event_sequence,
            }),
            claim.job.corpus_id,
            claim.job.source_kind,
            claim.job.source_id,
            prior.results[0].current_stage_id,
            claim.job.source_event_id,
            claim.job.source_event_sequence,
            eligible ? 'replace-all' : 'delete',
            now,
          ),
      );
    }
    statements.push(
      this.#db
        .prepare(
          `INSERT INTO taproot_search_materialization_heads(
             corpus_id, root_kind, root_id, current_stage_id,
             source_event_id, source_event_sequence, root_revision,
             root_hash, source_policy_revision, authorization_revision,
             producer_fingerprint, eligible, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(corpus_id, root_kind, root_id) DO UPDATE SET
             current_stage_id = excluded.current_stage_id,
             source_event_id = excluded.source_event_id,
             source_event_sequence = excluded.source_event_sequence,
             root_revision = excluded.root_revision,
             root_hash = excluded.root_hash,
             source_policy_revision = excluded.source_policy_revision,
             authorization_revision = excluded.authorization_revision,
             producer_fingerprint = excluded.producer_fingerprint,
             eligible = excluded.eligible, updated_at = excluded.updated_at
           WHERE excluded.source_event_sequence > taproot_search_materialization_heads.source_event_sequence`,
        )
        .bind(
          claim.job.corpus_id,
          claim.job.source_kind,
          claim.job.source_id,
          stageId,
          claim.job.source_event_id,
          claim.job.source_event_sequence,
          claim.job.root_revision,
          claim.job.root_hash,
          claim.job.source_policy_revision,
          claim.job.authorization_revision,
          claim.job.producer_fingerprint,
          eligible,
          now,
        ),
      this.#db
        .prepare(
          `INSERT INTO taproot_assertions(assertion_key)
           SELECT NULL WHERE NOT EXISTS (
             SELECT 1 FROM taproot_search_materialization_heads
             WHERE corpus_id = ? AND root_kind = ? AND root_id = ?
               AND current_stage_id = ? AND source_event_id = ?
               AND source_event_sequence = ? AND root_revision = ?
               AND root_hash = ? AND source_policy_revision = ?
               AND authorization_revision = ? AND producer_fingerprint IS ?
               AND eligible = ?
           )`,
        )
        .bind(
          claim.job.corpus_id,
          claim.job.source_kind,
          claim.job.source_id,
          stageId,
          claim.job.source_event_id,
          claim.job.source_event_sequence,
          claim.job.root_revision,
          claim.job.root_hash,
          claim.job.source_policy_revision,
          claim.job.authorization_revision,
          claim.job.producer_fingerprint,
          eligible,
        ),
      this.#db
        .prepare(
          `UPDATE taproot_search_stages SET state = 'committed', committed_at = ?
           WHERE stage_id = ? AND state = 'verified' AND claim_token = ?
             AND claim_generation = ?`,
        )
        .bind(now, stageId, claim.token, claim.generation),
      this.#db
        .prepare(
          `UPDATE taproot_search_projection_jobs
           SET state = 'complete', claim_token = NULL, lease_expires_at = NULL,
               updated_at = ?
           WHERE job_id = ? AND state = 'staged' AND claim_token = ?
             AND claim_generation = ? AND lease_expires_at > ?`,
        )
        .bind(now, claim.job.job_id, claim.token, claim.generation, now),
      this.#db
        .prepare(
          `INSERT INTO taproot_assertions(assertion_key)
           SELECT NULL WHERE NOT EXISTS (
             SELECT 1 FROM taproot_search_projection_jobs
             WHERE job_id = ? AND state = 'complete'
               AND claim_generation = ? AND claim_token IS NULL
           )`,
        )
        .bind(claim.job.job_id, claim.generation),
      this.#db
        .prepare(
          `INSERT INTO taproot_search_job_transitions(
             transition_id, job_id, from_state, to_state, attempt, created_at
           ) VALUES (?, ?, 'staged', 'complete', ?, ?)`,
        )
        .bind(transitionId, claim.job.job_id, claim.job.attempt, now),
      this.#db
        .prepare(
          `UPDATE taproot_search_kind_checkpoints
           SET applied_sequence = MAX(applied_sequence, ?)
           WHERE corpus_id = ? AND source_kind = ?`,
        )
        .bind(
          claim.job.source_event_sequence,
          claim.job.corpus_id,
          claim.job.source_kind,
        ),
    );
    await this.#db.batch(statements);
  }

  async #completeSuperseded(claim: Claim, code: string): Promise<void> {
    const now = this.#now();
    const transitionId = `${claim.job.job_id}:superseded:${claim.generation}`;
    await this.#db.batch([
      this.#db
        .prepare(
          `INSERT INTO taproot_search_job_transitions(
             transition_id, job_id, from_state, to_state, attempt,
             error_code, created_at
           )
           SELECT ?, job_id, state, 'complete', attempt, ?, ?
           FROM taproot_search_projection_jobs
           WHERE job_id = ? AND state IN ('leased', 'staged')
             AND claim_token = ? AND claim_generation = ?
             AND lease_expires_at > ?`,
        )
        .bind(
          transitionId,
          code,
          now,
          claim.job.job_id,
          claim.token,
          claim.generation,
          now,
        ),
      this.#db
        .prepare(
          `UPDATE taproot_search_projection_jobs
           SET state = 'complete', claim_token = NULL, lease_expires_at = NULL,
               last_error_code = ?, updated_at = ?
           WHERE job_id = ? AND state IN ('leased', 'staged')
             AND claim_token = ? AND claim_generation = ?
             AND lease_expires_at > ?`,
        )
        .bind(code, now, claim.job.job_id, claim.token, claim.generation, now),
      this.#db
        .prepare(
          `INSERT INTO taproot_assertions(assertion_key)
           SELECT NULL WHERE NOT EXISTS (
             SELECT 1 FROM taproot_search_projection_jobs j
             JOIN taproot_search_job_transitions t ON t.job_id = j.job_id
             WHERE j.job_id = ? AND j.state = 'complete'
               AND j.claim_generation = ? AND j.claim_token IS NULL
               AND t.transition_id = ?
           )`,
        )
        .bind(claim.job.job_id, claim.generation, transitionId),
    ]);
  }

  async #deferOrDead(claim: Claim, code: string): Promise<'deferred' | 'dead'> {
    const now = this.#now();
    const dead = claim.job.attempt >= MAX_ATTEMPTS;
    const nextState = dead ? 'dead' : 'pending';
    const delay = Math.min(
      60_000,
      250 * 2 ** Math.max(0, claim.job.attempt - 1),
    );
    const notBefore = new Date(new Date(now).getTime() + delay).toISOString();
    const transitionId = `${claim.job.job_id}:${nextState}:${claim.generation}`;
    await this.#db.batch([
      this.#db
        .prepare(
          `INSERT INTO taproot_search_job_transitions(
             transition_id, job_id, from_state, to_state, attempt,
             error_code, created_at
           )
           SELECT ?, job_id, state, ?, attempt, ?, ?
           FROM taproot_search_projection_jobs
           WHERE job_id = ? AND state IN ('leased', 'staged')
             AND claim_token = ? AND claim_generation = ?
             AND lease_expires_at > ?`,
        )
        .bind(
          transitionId,
          nextState,
          code,
          now,
          claim.job.job_id,
          claim.token,
          claim.generation,
          now,
        ),
      this.#db
        .prepare(
          `UPDATE taproot_search_projection_jobs
           SET state = ?, claim_token = NULL, lease_expires_at = NULL,
               not_before = ?, last_error_code = ?, updated_at = ?
           WHERE job_id = ? AND state IN ('leased', 'staged')
             AND claim_token = ? AND claim_generation = ?
             AND lease_expires_at > ?`,
        )
        .bind(
          nextState,
          notBefore,
          code,
          now,
          claim.job.job_id,
          claim.token,
          claim.generation,
          now,
        ),
      this.#db
        .prepare(
          `INSERT INTO taproot_assertions(assertion_key)
           SELECT NULL WHERE NOT EXISTS (
             SELECT 1 FROM taproot_search_projection_jobs j
             JOIN taproot_search_job_transitions t ON t.job_id = j.job_id
             WHERE j.job_id = ? AND j.state = ?
               AND j.claim_generation = ? AND j.claim_token IS NULL
               AND t.transition_id = ?
           )`,
        )
        .bind(claim.job.job_id, nextState, claim.generation, transitionId),
    ]);
    return dead ? 'dead' : 'deferred';
  }

  async #enumerateCorpusPage(corpusId: string, limit: number): Promise<number> {
    const corpus = await this.#db
      .prepare(
        `SELECT enumeration_cursor, enumeration_complete
         FROM taproot_search_corpora WHERE corpus_id = ?`,
      )
      .bind(corpusId)
      .all<{
        enumeration_cursor: string | null;
        enumeration_complete: number;
      }>();
    const row = corpus.results[0];
    if (!row || Number(row.enumeration_complete) === 1) return 0;
    const result = await this.#enqueueCurrentRegistryPage(
      corpusId,
      row.enumeration_cursor,
      limit,
    );
    const complete = result.count < limit;
    await this.#db
      .prepare(
        `UPDATE taproot_search_corpora
         SET enumeration_cursor = ?, enumeration_complete = ?
         WHERE corpus_id = ? AND enumeration_complete = 0`,
      )
      .bind(result.cursor, complete ? 1 : 0, corpusId)
      .run();
    return result.count;
  }

  async #enqueueCurrentRegistryPage(
    corpusId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ count: number; cursor: string | null }> {
    const rows = await this.#db
      .prepare(
        `SELECT r.*, e.sequence, e.event_id, e.operation, e.source_hash,
                e.source_policy_revision, e.authorization_revision,
                e.search_generation, e.created_at, p.producer_fingerprint
         FROM taproot_unified_search_source_registry r
         JOIN taproot_unified_search_source_events e
           ON e.sequence = r.current_event_sequence AND e.event_id = r.current_event_id
         JOIN taproot_unified_search_generation_producers p
           ON p.corpus_id = ? AND p.installation_id = r.installation_id
          AND p.source_kind = r.source_kind AND p.state = 'ready'
         WHERE r.installation_id = ?
           AND (? IS NULL OR r.source_kind || ':' || r.source_id > ?)
         ORDER BY r.source_kind, r.source_id LIMIT ?`,
      )
      .bind(corpusId, this.#installationId, cursor, cursor, limit)
      .all<Record<string, unknown>>();
    for (const row of rows.results) {
      const key = `${String(row.source_kind)}:${String(row.source_id)}`;
      const eventSequence = Number(row.sequence);
      const jobId = `${corpusId}:${String(row.event_id)}`;
      await this.#db.batch([
        this.#db
          .prepare(
            `INSERT INTO taproot_search_rebuild_roots(
               corpus_id, root_kind, root_id, source_event_id,
               source_event_sequence, enumerated
             ) VALUES (?, ?, ?, ?, ?, 1)
             ON CONFLICT(corpus_id, root_kind, root_id) DO UPDATE SET
               source_event_id = excluded.source_event_id,
               source_event_sequence = excluded.source_event_sequence,
               enumerated = 1
             WHERE excluded.source_event_sequence > taproot_search_rebuild_roots.source_event_sequence`,
          )
          .bind(
            corpusId,
            row.source_kind,
            row.source_id,
            row.event_id,
            eventSequence,
          ),
        this.#db
          .prepare(
            `INSERT INTO taproot_search_projection_jobs(
               job_id, corpus_id, installation_id, source_event_id,
               source_event_sequence, source_kind, source_id, operation,
               root_revision, root_hash, source_policy_revision,
               authorization_revision, search_generation, producer_fingerprint,
               state, not_before, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
             ON CONFLICT(corpus_id, source_event_id) DO NOTHING`,
          )
          .bind(
            jobId,
            corpusId,
            this.#installationId,
            row.event_id,
            eventSequence,
            row.source_kind,
            row.source_id,
            row.operation,
            row.source_revision,
            row.source_hash,
            row.source_policy_revision,
            row.authorization_revision,
            row.search_generation,
            row.producer_fingerprint,
            row.created_at,
            row.created_at,
            row.created_at,
          ),
        this.#db
          .prepare(
            `UPDATE taproot_search_kind_checkpoints
             SET enqueued_sequence = MAX(enqueued_sequence, ?)
             WHERE corpus_id = ? AND source_kind = ?`,
          )
          .bind(eventSequence, corpusId, row.source_kind),
      ]);
      cursor = key;
    }
    return { count: rows.results.length, cursor };
  }

  async #refreshShadowReadiness(corpusId: string): Promise<void> {
    const high = await this.#sourceHighWatermark();
    const blockers = await this.#db
      .prepare(
        `SELECT
           (SELECT enumeration_complete FROM taproot_search_corpora
             WHERE corpus_id = ?) AS enumeration_complete,
           (SELECT COUNT(*) FROM taproot_search_projection_jobs
             WHERE corpus_id = ? AND state != 'complete') AS jobs,
           (SELECT COUNT(*)
              FROM taproot_unified_search_source_registry r
              LEFT JOIN taproot_search_materialization_heads h
                ON h.corpus_id = ? AND h.root_kind = r.source_kind
               AND h.root_id = r.source_id
             WHERE r.installation_id = ?
               AND r.source_kind != 'statement'
               AND (h.source_event_sequence IS NULL
                 OR h.source_event_sequence != r.current_event_sequence)) AS anti_join`,
      )
      .bind(corpusId, corpusId, corpusId, this.#installationId)
      .all<{ enumeration_complete: number; jobs: number; anti_join: number }>();
    const row = blockers.results[0];
    const ready =
      Number(row?.enumeration_complete) === 1 &&
      Number(row?.jobs) === 0 &&
      Number(row?.anti_join) === 0;
    await this.#db
      .prepare(
        `UPDATE taproot_search_corpora
         SET state = ?, source_watermark_sequence = ?, ready_at = ?
         WHERE corpus_id = ? AND role = 'shadow'
           AND state IN ('building', 'ready')`,
      )
      .bind(
        ready ? 'ready' : 'building',
        ready ? high : 0,
        ready ? this.#now() : null,
        corpusId,
      )
      .run();
  }

  async #currentRegistry(job: JobRow): Promise<boolean> {
    const result = await this.#db
      .prepare(
        `SELECT 1 AS present FROM taproot_unified_search_source_registry
         WHERE installation_id = ? AND source_kind = ? AND source_id = ?
           AND current_event_id = ? AND current_event_sequence = ?
           AND source_revision = ? AND source_hash = ?
           AND authorization_revision = ?`,
      )
      .bind(
        this.#installationId,
        job.source_kind,
        job.source_id,
        job.source_event_id,
        job.source_event_sequence,
        job.root_revision,
        job.root_hash,
        job.authorization_revision,
      )
      .all<{ present: number }>();
    return result.results.length === 1;
  }

  async #authorize(
    rawContext: AuthorizationContext,
  ): Promise<AuthorizationContext> {
    const context = normalizeAuthorizationContext(rawContext);
    if (
      context.installationId !== this.#installationId ||
      !context.capabilities.includes(SEARCH_ADMIN_CAPABILITY)
    )
      throw new InvalidAuthorizationError('search administration denied');
    const state = await this.#db
      .prepare(
        `SELECT authorization_revision FROM taproot_installation_authorization
         WHERE singleton = 1 AND installation_id = ?`,
      )
      .bind(this.#installationId)
      .all<{ authorization_revision: number }>();
    if (
      Number(state.results[0]?.authorization_revision) !==
      context.authorizationRevision
    )
      throw new InvalidAuthorizationError('search administration denied');
    return context;
  }

  async #state() {
    const result = await this.#db
      .prepare(
        `SELECT * FROM taproot_search_installation_state WHERE installation_id = ?`,
      )
      .bind(this.#installationId)
      .all<{
        active_corpus_id: string;
        shadow_corpus_id: string | null;
        cursor_generation: number;
        last_error_code: string | null;
      }>();
    return result.results[0] ?? null;
  }

  async #requiredState() {
    const state = await this.#state();
    if (!state)
      throw new InvalidAuthorizationError(
        'search materialization is not initialized',
      );
    return state;
  }

  async #sourceHighWatermark(): Promise<number> {
    const result = await this.#db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) AS sequence
         FROM taproot_unified_search_source_events WHERE installation_id = ?`,
      )
      .bind(this.#installationId)
      .all<{ sequence: number }>();
    return Number(result.results[0]?.sequence ?? 0);
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

function projectionSource(
  job: JobRow,
  installationId: string,
): SearchProjectionSourceEventV1 {
  return {
    version: 1,
    eventId: job.source_event_id,
    operation: job.operation,
    installationId,
    kind: job.source_kind,
    sourceId: job.source_id,
    sourceRevision: job.root_revision,
    sourceHash: job.root_hash,
    sourcePolicyRevision: Number(job.source_policy_revision),
    authorizationRevision: Number(job.authorization_revision),
    searchGeneration: Number(job.search_generation),
  };
}

async function emptyPlan(
  job: JobRow,
  installationId: string,
): Promise<SearchProjectionPlanV1> {
  const source = projectionSource(job, installationId);
  const payload = {
    version: 1 as const,
    source,
    documents: [],
    chunks: [],
    replaceAll: true as const,
    removeDocumentSlots: [],
  };
  return {
    ...payload,
    id: await stableId('plan', payload),
    hash: await canonicalSearchHashV1(payload),
  };
}

function normalizeRunOptions(
  value: SearchMaterializationRunOptionsV1,
): Required<SearchMaterializationRunOptionsV1> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InvalidAuthorizationError('search run options are invalid');
  const keys = Object.keys(value).sort().join(',');
  if (
    keys !== 'leaseMilliseconds,maxChunkBytes,maxJobs,maxRebuildRoots' &&
    keys !== 'maxChunkBytes,maxJobs,maxRebuildRoots' &&
    keys !== 'leaseMilliseconds,maxJobs,maxRebuildRoots' &&
    keys !== 'maxJobs,maxRebuildRoots'
  )
    throw new InvalidAuthorizationError('search run options are invalid');
  return {
    maxJobs: boundedInteger(value.maxJobs, 'maxJobs', 1, MAX_RUN_JOBS),
    maxRebuildRoots: boundedInteger(
      value.maxRebuildRoots,
      'maxRebuildRoots',
      1,
      MAX_REBUILD_ROOTS,
    ),
    maxChunkBytes:
      value.maxChunkBytes === undefined
        ? UNIFIED_SEARCH_LIMITS.defaultChunkBytes
        : boundedInteger(
            value.maxChunkBytes,
            'maxChunkBytes',
            UNIFIED_SEARCH_LIMITS.minChunkBytes,
            UNIFIED_SEARCH_LIMITS.maxChunkBytes,
          ),
    leaseMilliseconds:
      value.leaseMilliseconds === undefined
        ? 30_000
        : boundedInteger(
            value.leaseMilliseconds,
            'leaseMilliseconds',
            1_000,
            300_000,
          ),
  };
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  )
    throw new InvalidAuthorizationError(`${field} is invalid`);
  return Number(value);
}

function randomToken128(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function stableId(namespace: string, value: unknown): Promise<string> {
  return `taproot:${namespace}:v1:${await canonicalSearchHashV1(value)}`;
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

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function isTextualMediaType(value: string): boolean {
  const mediaType = value.toLowerCase().split(';', 1)[0]!.trim();
  return (
    mediaType.startsWith('text/') ||
    mediaType === 'application/json' ||
    mediaType.endsWith('+json') ||
    mediaType === 'application/xml' ||
    mediaType.endsWith('+xml') ||
    mediaType === 'application/javascript'
  );
}

function allStatements(item: Item) {
  return Object.keys(item.claims)
    .sort()
    .flatMap(
      (property) => item.claims[property as keyof typeof item.claims] ?? [],
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

function visibilityAtom(atom: VisibilityAtomV1): {
  kind: string;
  value: string | null;
} {
  switch (atom.kind) {
    case 'public':
      return { kind: atom.kind, value: null };
    case 'principal':
      return { kind: atom.kind, value: atom.principalId };
    case 'workspace':
      return { kind: atom.kind, value: atom.workspaceId };
    case 'capability':
      return { kind: atom.kind, value: atom.capability };
  }
}

function filterValues(
  document: DerivedSearchDocumentV1,
): Array<[string, string]> {
  const values: Array<[string, string]> = [];
  for (const value of document.filterMetadata.languages)
    values.push(['language', value]);
  for (const value of document.filterMetadata.sourceRevisions)
    values.push(['source_revision', value]);
  for (const value of document.filterMetadata.byKind.statement?.predicateIds ??
    [])
    values.push(['predicate_id', value]);
  for (const value of document.filterMetadata.byKind.item?.typeIds ?? [])
    values.push(['type_id', value]);
  return values;
}

function validateChunkFence(
  document: DerivedSearchDocumentV1,
  chunk: SearchProjectionPlanV1['chunks'][number],
): void {
  if (
    chunk.documentStart < 0 ||
    chunk.documentEnd < chunk.documentStart ||
    chunk.documentEnd > document.text.length ||
    document.text.slice(chunk.documentStart, chunk.documentEnd) !==
      chunk.text ||
    chunk.trace.length === 0 ||
    chunk.trace.some(
      (trace) =>
        trace.documentStart < chunk.documentStart ||
        trace.documentEnd > chunk.documentEnd ||
        trace.chunkStart < 0 ||
        trace.chunkEnd > chunk.text.length ||
        trace.chunkEnd < trace.chunkStart,
    )
  )
    throw new Error('search chunk trace fence is invalid');
}

function* pages<T>(values: readonly T[], size: number): Generator<T[]> {
  for (let index = 0; index < values.length; index += size)
    yield values.slice(index, index + size);
}
