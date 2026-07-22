import type {
  SqliteDatabaseLike,
  SqlitePreparedStatementLike,
} from '@gnolith/diamond';
import {
  isVisibleTo,
  normalizeAuthorizationContext,
  SEARCH_ADMIN_CAPABILITY,
} from './authorization.js';
import {
  canonicalSearchHashV1,
  type UnifiedSearchKind,
  UNIFIED_SEARCH_KINDS,
} from './search-contract.js';
import type {
  SemanticSearchAugmenterV1,
  SemanticSearchCandidateV1,
} from './search-service.js';
import type {
  AuthorizationContext,
  VisibilityAtomV1,
  VisibilityScopeV1,
} from './types.js';

export type VectorMetricV1 = 'cosine' | 'dot' | 'euclid';

export interface EmbeddingProviderIdentityV1 {
  kind: 'openai-compatible' | 'ollama-compatible';
  endpoint: string;
  model: string;
  dimensions: number;
  metric: VectorMetricV1;
}

export interface EmbeddingBatchResultV1 {
  vectors: readonly (readonly number[])[];
  usage: { tokens: number | null };
}

export interface EmbeddingProviderPortV1 {
  readonly identity: Readonly<EmbeddingProviderIdentityV1>;
  embed(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<EmbeddingBatchResultV1>;
}

export interface VectorRecordV1 {
  id: string;
  installationId: string;
  configurationId: string;
  generation: number;
  kind: Exclude<UnifiedSearchKind, 'statement'>;
  sourceId: string;
  sourceRevision: string;
  documentId: string;
  chunkId: string | null;
  contentHash: string;
  authorization: VisibilityScopeV1;
  selector: unknown;
  vector: readonly number[];
}

export interface VectorQueryV1 {
  installationId: string;
  configurationId: string;
  generation: number;
  kinds: readonly UnifiedSearchKind[];
  vector: readonly number[];
  limit: number;
  context: AuthorizationContext;
}

export interface VectorIndexPortV1 {
  readonly kind: 'sqlite' | 'qdrant';
  validate(
    dimensions: number,
    metric: VectorMetricV1,
    signal?: AbortSignal,
  ): Promise<void>;
  upsert(
    records: readonly VectorRecordV1[],
    dimensions: number,
    metric: VectorMetricV1,
    signal?: AbortSignal,
  ): Promise<void>;
  query(
    input: VectorQueryV1,
    dimensions: number,
    metric: VectorMetricV1,
    signal?: AbortSignal,
  ): Promise<readonly SemanticSearchCandidateV1[]>;
  delete(
    input: {
      installationId: string;
      configurationId: string;
      generation?: number;
      ids?: readonly string[];
    },
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface CompatibleEmbeddingAdapterOptionsV1 {
  endpoint: string;
  model: string;
  dimensions: number;
  metric?: VectorMetricV1;
  secret?: () => string | Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBatchSize?: number;
  maxResponseBytes?: number;
  allowPrivateEndpoint?: boolean;
}

export interface QdrantVectorAdapterOptionsV1 {
  endpoint: string;
  collection: string;
  secret?: () => string | Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  allowPrivateEndpoint?: boolean;
}

export interface EmbeddingEstimateV1 {
  records: number;
  chunks: number;
  tokens: number;
  dimensions: number;
  batches: number;
  earliestStart: string;
  latestFinish: string | null;
  cost: { minimumMicrounits: number; maximumMicrounits: number } | null;
  assumptions: readonly string[];
}

export interface EmbeddingSchedulePolicyV1 {
  mode: 'asap' | 'window';
  window?: { startHourUtc: number; endHourUtc: number };
  maxBatchesPerRun?: number;
  maxTokensPerMinute?: number;
  dailySpendMicrounits?: number;
  monthlySpendMicrounits?: number;
  costPerThousandTokensMicrounits?: { minimum: number; maximum: number };
}

export interface SemanticConfigurationInputV1 {
  id: string;
  name: string;
  provider: EmbeddingProviderPortV1;
  vectorIndex: VectorIndexPortV1;
  vectorEndpoint?: string;
}

export interface SemanticSearchAdminV1 extends SemanticSearchAugmenterV1 {
  configure(
    input: SemanticConfigurationInputV1,
    context: AuthorizationContext,
  ): Promise<void>;
  select(configurationId: string, context: AuthorizationContext): Promise<void>;
  reconnect(
    configurationId: string,
    context: AuthorizationContext,
  ): Promise<boolean>;
  estimate(
    configurationId: string,
    policy: EmbeddingSchedulePolicyV1,
    context: AuthorizationContext,
  ): Promise<{ planId: string; estimate: EmbeddingEstimateV1 }>;
  approve(planId: string, context: AuthorizationContext): Promise<void>;
  run(
    planId: string,
    context: AuthorizationContext,
    signal?: AbortSignal,
  ): Promise<SemanticAdminStatusV1>;
  resume(
    planId: string,
    context: AuthorizationContext,
    signal?: AbortSignal,
  ): Promise<SemanticAdminStatusV1>;
  pause(planId: string, context: AuthorizationContext): Promise<void>;
  stop(planId: string, context: AuthorizationContext): Promise<void>;
  retry(planId: string, context: AuthorizationContext): Promise<void>;
  exclude(
    configurationId: string,
    generation: number,
    derivedId: string,
    reason: string,
    context: AuthorizationContext,
  ): Promise<void>;
  retire(configurationId: string, context: AuthorizationContext): Promise<void>;
  deleteEmbeddings(
    configurationId: string,
    context: AuthorizationContext,
  ): Promise<void>;
  status(context: AuthorizationContext): Promise<SemanticAdminStatusV1>;
}

export interface SemanticAdminStatusV1 {
  configured: number;
  selectedConfigurationId: string | null;
  selectedReady: boolean;
  circuitOpen: boolean;
  plans: Array<{
    planId: string;
    state: string;
    generation: number;
    pending: number;
    complete: number;
    failed: number;
    excluded: number;
    estimatedTokens: number;
    actualTokens: number;
  }>;
}

export interface SemanticSearchAdminOptionsV1 {
  installationId: string;
  clock?: () => Date;
  createId?: () => string;
  warn?: (message: string) => void;
  maxAttempts?: number;
  batchSize?: number;
}

interface SemanticRow {
  configuration_id: string;
  provider_kind: EmbeddingProviderIdentityV1['kind'];
  provider_url: string;
  model: string;
  dimensions: number;
  metric: VectorMetricV1;
  vector_kind: VectorIndexPortV1['kind'];
  fingerprint: string;
  selected: number;
  state: string;
  circuit_open: number;
  warning_emitted: number;
  active_generation: number;
  ready_generation: number | null;
}

interface CorpusRecord {
  id: string;
  kind: Exclude<UnifiedSearchKind, 'statement'>;
  sourceId: string;
  sourceRevision: string;
  documentId: string;
  chunkId: string | null;
  contentHash: string;
  text: string;
  authorization: VisibilityScopeV1;
  selector: unknown;
}

interface RuntimeBinding {
  provider: EmbeddingProviderPortV1;
  vector: VectorIndexPortV1;
}

const encoder = new TextEncoder();
const processCircuits = new Set<string>();

export function createOpenAICompatibleEmbeddingProviderV1(
  options: CompatibleEmbeddingAdapterOptionsV1,
): EmbeddingProviderPortV1 {
  return createHttpEmbeddingProvider('openai-compatible', options);
}

export function createOllamaCompatibleEmbeddingProviderV1(
  options: CompatibleEmbeddingAdapterOptionsV1,
): EmbeddingProviderPortV1 {
  return createHttpEmbeddingProvider('ollama-compatible', options);
}

function createHttpEmbeddingProvider(
  kind: EmbeddingProviderIdentityV1['kind'],
  options: CompatibleEmbeddingAdapterOptionsV1,
): EmbeddingProviderPortV1 {
  const endpoint = safeEndpoint(
    options.endpoint,
    options.allowPrivateEndpoint ?? false,
  );
  const model = token(options.model, 'model', 256);
  const dimensions = positive(options.dimensions, 'dimensions', 65_536);
  const metric = options.metric ?? 'cosine';
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = positive(options.timeoutMs ?? 30_000, 'timeoutMs', 300_000);
  const maxBatchSize = positive(
    options.maxBatchSize ?? 128,
    'maxBatchSize',
    2048,
  );
  const maxResponseBytes = positive(
    options.maxResponseBytes ?? 4_194_304,
    'maxResponseBytes',
    67_108_864,
  );
  const identity = Object.freeze({
    kind,
    endpoint: endpoint.href.replace(/\/$/u, ''),
    model,
    dimensions,
    metric,
  });
  return Object.freeze({
    identity,
    async embed(
      texts: readonly string[],
      signal?: AbortSignal,
    ): Promise<EmbeddingBatchResultV1> {
      if (
        !Array.isArray(texts) ||
        texts.length < 1 ||
        texts.length > maxBatchSize ||
        texts.some(
          (text) =>
            typeof text !== 'string' ||
            text.length === 0 ||
            encoder.encode(text).byteLength > 1_800_000,
        )
      )
        throw new Error('embedding batch is invalid');
      const secret = options.secret ? await options.secret() : undefined;
      const url = new URL(
        kind === 'openai-compatible' ? 'embeddings' : 'api/embed',
        `${identity.endpoint}/`,
      );
      const body =
        kind === 'openai-compatible'
          ? { model, input: texts, dimensions }
          : { model, input: texts, dimensions };
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (secret) headers.authorization = `Bearer ${secret}`;
      const response = await boundedFetch(
        fetcher,
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          ...(signal === undefined ? {} : { signal }),
        },
        timeoutMs,
        maxResponseBytes,
      );
      if (!response.ok)
        throw redactedAdapterError(
          `embedding provider returned ${response.status}`,
        );
      const json = JSON.parse(response.text) as Record<string, unknown>;
      const vectors =
        kind === 'openai-compatible'
          ? normalizeVectors(
              (json.data as Array<{ embedding: unknown }> | undefined)?.map(
                (entry) => entry.embedding,
              ),
              texts.length,
              dimensions,
            )
          : normalizeVectors(
              json.embeddings ??
                (json.embedding ? [json.embedding] : undefined),
              texts.length,
              dimensions,
            );
      const usage = json.usage as
        { total_tokens?: unknown; prompt_tokens?: unknown } | undefined;
      const tokens = numberOrNull(usage?.total_tokens ?? usage?.prompt_tokens);
      return { vectors, usage: { tokens } };
    },
  });
}

export function createSqliteVectorIndexV1(
  db: SqliteDatabaseLike,
): VectorIndexPortV1 {
  const adapter: VectorIndexPortV1 = {
    kind: 'sqlite' as const,
    async validate(dimensions: number, metric: VectorMetricV1): Promise<void> {
      positive(dimensions, 'dimensions', 65_536);
      normalizeMetric(metric);
      await db
        .prepare(`SELECT COUNT(*) AS count FROM taproot_embedding_vectors`)
        .all();
    },
    async upsert(
      records: readonly VectorRecordV1[],
      dimensions: number,
      metric: VectorMetricV1,
    ): Promise<void> {
      const statements = records.map((record) => {
        validateVectorRecord(record, dimensions, metric);
        return db
          .prepare(
            `INSERT INTO taproot_embedding_vectors(configuration_id, generation, installation_id, derived_id, kind, source_id, source_revision, document_id, chunk_id, content_hash, authorization_json, selector_json, vector_json, dimensions, metric, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(configuration_id, generation, derived_id) DO UPDATE SET source_revision=excluded.source_revision, content_hash=excluded.content_hash, authorization_json=excluded.authorization_json, selector_json=excluded.selector_json, vector_json=excluded.vector_json, created_at=excluded.created_at`,
          )
          .bind(
            record.configurationId,
            record.generation,
            record.installationId,
            record.id,
            record.kind,
            record.sourceId,
            record.sourceRevision,
            record.documentId,
            record.chunkId,
            record.contentHash,
            JSON.stringify(record.authorization),
            record.selector === null ? null : JSON.stringify(record.selector),
            JSON.stringify(record.vector),
            dimensions,
            metric,
            new Date().toISOString(),
          );
      });
      if (statements.length) await db.batch(statements);
    },
    async query(
      input: VectorQueryV1,
      dimensions: number,
      metric: VectorMetricV1,
    ): Promise<readonly SemanticSearchCandidateV1[]> {
      validateVector(input.vector, dimensions);
      normalizeMetric(metric);
      const kinds = input.kinds.filter(
        (kind): kind is Exclude<UnifiedSearchKind, 'statement'> =>
          kind !== 'statement',
      );
      if (!kinds.length) return [];
      const result = await db
        .prepare(
          `SELECT derived_id, authorization_json, vector_json FROM taproot_embedding_vectors WHERE installation_id = ? AND configuration_id = ? AND generation = ? AND kind IN (${kinds.map(() => '?').join(',')})`,
        )
        .bind(
          input.installationId,
          input.configurationId,
          input.generation,
          ...kinds,
        )
        .all<{
          derived_id: string;
          authorization_json: string;
          vector_json: string;
        }>();
      return result.results
        .filter((row) =>
          isVisibleTo(
            JSON.parse(row.authorization_json) as VisibilityScopeV1,
            input.context,
          ),
        )
        .map((row) => ({
          derivedId: row.derived_id,
          score: similarity(
            input.vector,
            JSON.parse(row.vector_json) as number[],
            metric,
          ),
        }))
        .sort(
          (left, right) =>
            right.score - left.score ||
            compare(left.derivedId, right.derivedId),
        )
        .slice(0, input.limit);
    },
    async delete(input: {
      installationId: string;
      configurationId: string;
      generation?: number;
      ids?: readonly string[];
    }): Promise<void> {
      if (input.ids?.length)
        await db
          .prepare(
            `DELETE FROM taproot_embedding_vectors WHERE installation_id = ? AND configuration_id = ? AND derived_id IN (${input.ids.map(() => '?').join(',')})${input.generation === undefined ? '' : ' AND generation = ?'}`,
          )
          .bind(
            input.installationId,
            input.configurationId,
            ...input.ids,
            ...(input.generation === undefined ? [] : [input.generation]),
          )
          .run();
      else
        await db
          .prepare(
            `DELETE FROM taproot_embedding_vectors WHERE installation_id = ? AND configuration_id = ?${input.generation === undefined ? '' : ' AND generation = ?'}`,
          )
          .bind(
            input.installationId,
            input.configurationId,
            ...(input.generation === undefined ? [] : [input.generation]),
          )
          .run();
    },
  };
  return Object.freeze(adapter);
}

export function createQdrantVectorIndexV1(
  options: QdrantVectorAdapterOptionsV1,
): VectorIndexPortV1 {
  const endpoint = safeEndpoint(
    options.endpoint,
    options.allowPrivateEndpoint ?? false,
  );
  const collection = token(options.collection, 'collection', 128);
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = positive(options.timeoutMs ?? 30_000, 'timeoutMs', 300_000);
  const maxResponseBytes = positive(
    options.maxResponseBytes ?? 4_194_304,
    'maxResponseBytes',
    67_108_864,
  );
  const request = async (
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ) => {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    const secret = options.secret ? await options.secret() : undefined;
    if (secret) headers.set('api-key', secret);
    const response = await boundedFetch(
      fetcher,
      new URL(path, `${endpoint.href.replace(/\/$/u, '')}/`),
      { ...init, headers, ...(signal === undefined ? {} : { signal }) },
      timeoutMs,
      maxResponseBytes,
    );
    if (!response.ok)
      throw redactedAdapterError(`vector index returned ${response.status}`);
    return response.text
      ? (JSON.parse(response.text) as Record<string, unknown>)
      : {};
  };
  const adapter: VectorIndexPortV1 = {
    kind: 'qdrant' as const,
    async validate(
      dimensions: number,
      metric: VectorMetricV1,
      signal?: AbortSignal,
    ) {
      positive(dimensions, 'dimensions', 65_536);
      const collectionInfo = await request(
        `collections/${encodeURIComponent(collection)}`,
        { method: 'GET' },
        signal,
      );
      const vectors = (
        collectionInfo.result as
          | {
              config?: {
                params?: {
                  vectors?: { size?: number; distance?: string };
                };
              };
            }
          | undefined
      )?.config?.params?.vectors;
      const expectedDistance =
        metric === 'cosine' ? 'cosine' : metric === 'dot' ? 'dot' : 'euclid';
      if (
        Number(vectors?.size) !== dimensions ||
        String(vectors?.distance ?? '').toLowerCase() !== expectedDistance
      )
        throw new Error('vector index dimensions or metric mismatch');
      const probeId = crypto.randomUUID();
      const probe = new Array<number>(dimensions).fill(0);
      probe[0] = 1;
      await request(
        `collections/${encodeURIComponent(collection)}/points?wait=true`,
        {
          method: 'PUT',
          body: JSON.stringify({
            points: [
              {
                id: probeId,
                vector: probe,
                payload: { taproot_probe: true, metric },
              },
            ],
          }),
        },
        signal,
      );
      await request(
        `collections/${encodeURIComponent(collection)}/points/delete?wait=true`,
        { method: 'POST', body: JSON.stringify({ points: [probeId] }) },
        signal,
      );
    },
    async upsert(
      records: readonly VectorRecordV1[],
      dimensions: number,
      metric: VectorMetricV1,
      signal?: AbortSignal,
    ) {
      records.forEach((record) =>
        validateVectorRecord(record, dimensions, metric),
      );
      if (!records.length) return;
      const points = await Promise.all(
        records.map(async (record) => ({
          id: await qdrantPointId(record.id),
          vector: record.vector,
          payload: { ...record, vector: undefined },
        })),
      );
      await request(
        `collections/${encodeURIComponent(collection)}/points?wait=true`,
        {
          method: 'PUT',
          body: JSON.stringify({ points }),
        },
        signal,
      );
    },
    async query(
      input: VectorQueryV1,
      dimensions: number,
      metric: VectorMetricV1,
      signal?: AbortSignal,
    ) {
      validateVector(input.vector, dimensions);
      normalizeMetric(metric);
      const kinds = input.kinds.filter((kind) => kind !== 'statement');
      if (!kinds.length) return [];
      const response = await request(
        `collections/${encodeURIComponent(collection)}/points/query`,
        {
          method: 'POST',
          body: JSON.stringify({
            query: input.vector,
            limit: input.limit * 4,
            with_payload: true,
            filter: {
              must: [
                {
                  key: 'installationId',
                  match: { value: input.installationId },
                },
                {
                  key: 'configurationId',
                  match: { value: input.configurationId },
                },
                { key: 'generation', match: { value: input.generation } },
                { key: 'kind', match: { any: kinds } },
              ],
            },
          }),
        },
        signal,
      );
      const points = ((response.result as { points?: unknown[] } | undefined)
        ?.points ??
        response.result ??
        []) as Array<{
        id: string | number;
        score: number;
        payload?: {
          id?: string | number;
          authorization?: VisibilityScopeV1;
        };
      }>;
      return points
        .filter(
          (point) =>
            point.payload?.authorization &&
            isVisibleTo(point.payload.authorization, input.context),
        )
        .map((point) => ({
          derivedId: String(point.payload?.id ?? point.id),
          score: Number(point.score),
        }))
        .slice(0, input.limit);
    },
    async delete(
      input: {
        installationId: string;
        configurationId: string;
        generation?: number;
        ids?: readonly string[];
      },
      signal?: AbortSignal,
    ) {
      const filter = {
        must: [
          { key: 'installationId', match: { value: input.installationId } },
          { key: 'configurationId', match: { value: input.configurationId } },
          ...(input.generation === undefined
            ? []
            : [{ key: 'generation', match: { value: input.generation } }]),
        ],
      };
      await request(
        `collections/${encodeURIComponent(collection)}/points/delete?wait=true`,
        {
          method: 'POST',
          body: JSON.stringify(
            input.ids?.length
              ? { points: await Promise.all(input.ids.map(qdrantPointId)) }
              : { filter },
          ),
        },
        signal,
      );
    },
  };
  return Object.freeze(adapter);
}

export function createSemanticSearchAdminV1(
  db: SqliteDatabaseLike,
  options: SemanticSearchAdminOptionsV1,
): SemanticSearchAdminV1 {
  return new SemanticRuntime(db, options);
}

class SemanticRuntime implements SemanticSearchAdminV1 {
  readonly #db: SqliteDatabaseLike;
  readonly #installationId: string;
  readonly #clock: () => Date;
  readonly #createId: () => string;
  readonly #warn: (message: string) => void;
  readonly #maxAttempts: number;
  readonly #batchSize: number;
  readonly #bindings = new Map<string, RuntimeBinding>();

  constructor(db: SqliteDatabaseLike, options: SemanticSearchAdminOptionsV1) {
    this.#db = db;
    this.#installationId = token(options.installationId, 'installationId', 128);
    this.#clock = options.clock ?? (() => new Date());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#warn = options.warn ?? (() => undefined);
    this.#maxAttempts = positive(options.maxAttempts ?? 3, 'maxAttempts', 3);
    this.#batchSize = positive(options.batchSize ?? 32, 'batchSize', 128);
  }

  async configure(
    input: SemanticConfigurationInputV1,
    context: AuthorizationContext,
  ): Promise<void> {
    const actor = this.#admin(context);
    const id = token(input.id, 'configurationId', 128);
    const name = token(input.name, 'configurationName', 128);
    if (input.provider.identity.dimensions < 1)
      throw new Error('invalid provider dimensions');
    if (
      input.vectorIndex.kind !== 'sqlite' &&
      input.vectorIndex.kind !== 'qdrant'
    )
      throw new Error('invalid vector adapter');
    const fingerprint = await canonicalSearchHashV1({
      version: 1,
      provider: input.provider.identity,
      vectorKind: input.vectorIndex.kind,
      vectorEndpoint: input.vectorEndpoint ?? null,
    });
    const now = this.#now();
    await this.#db.batch([
      this.#db
        .prepare(
          `INSERT INTO taproot_semantic_configurations(configuration_id, installation_id, name, provider_kind, provider_url, model, dimensions, metric, vector_kind, vector_url, fingerprint, selected, state, active_generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'unvalidated', 1, ?, ?) ON CONFLICT(configuration_id) DO UPDATE SET name=excluded.name, provider_kind=excluded.provider_kind, provider_url=excluded.provider_url, model=excluded.model, dimensions=excluded.dimensions, metric=excluded.metric, vector_kind=excluded.vector_kind, vector_url=excluded.vector_url, fingerprint=excluded.fingerprint, state=CASE WHEN taproot_semantic_configurations.fingerprint=excluded.fingerprint THEN taproot_semantic_configurations.state ELSE 'unvalidated' END, active_generation=CASE WHEN taproot_semantic_configurations.fingerprint=excluded.fingerprint THEN taproot_semantic_configurations.active_generation ELSE taproot_semantic_configurations.active_generation+1 END, ready_generation=CASE WHEN taproot_semantic_configurations.fingerprint=excluded.fingerprint THEN taproot_semantic_configurations.ready_generation ELSE NULL END, circuit_open=0, warning_emitted=0, updated_at=excluded.updated_at WHERE taproot_semantic_configurations.installation_id=excluded.installation_id`,
        )
        .bind(
          id,
          this.#installationId,
          name,
          input.provider.identity.kind,
          input.provider.identity.endpoint,
          input.provider.identity.model,
          input.provider.identity.dimensions,
          input.provider.identity.metric,
          input.vectorIndex.kind,
          input.vectorEndpoint ?? null,
          fingerprint,
          now,
          now,
        ),
      this.#audit('configure', actor.principalId, id, null, { fingerprint }),
    ]);
    this.#bindings.set(id, {
      provider: input.provider,
      vector: input.vectorIndex,
    });
    await this.#validate(id, actor);
  }

  async select(
    configurationId: string,
    context: AuthorizationContext,
  ): Promise<void> {
    const actor = this.#admin(context);
    const id = token(configurationId, 'configurationId', 128);
    const config = await this.#config(id);
    await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE taproot_semantic_configurations SET selected = 0, updated_at = ? WHERE installation_id = ? AND selected = 1`,
        )
        .bind(this.#now(), this.#installationId),
      this.#db
        .prepare(
          `UPDATE taproot_semantic_configurations SET selected = 1, updated_at = ? WHERE installation_id = ? AND configuration_id = ?`,
        )
        .bind(this.#now(), this.#installationId, id),
      this.#audit('select', actor.principalId, id, null, {
        ready:
          config.ready_generation === config.active_generation &&
          config.state === 'ready',
      }),
    ]);
  }

  async reconnect(
    configurationId: string,
    context: AuthorizationContext,
  ): Promise<boolean> {
    const actor = this.#admin(context);
    const id = token(configurationId, 'configurationId', 128);
    processCircuits.delete(this.#circuitKey(id));
    await this.#db
      .prepare(
        `UPDATE taproot_semantic_configurations SET circuit_open=0, warning_emitted=0, failure_code=NULL, state=CASE WHEN ready_generation=active_generation THEN 'ready' ELSE 'unvalidated' END, updated_at=? WHERE installation_id=? AND configuration_id=?`,
      )
      .bind(this.#now(), this.#installationId, id)
      .run();
    const ok = await this.#validate(id, actor);
    await this.#db.batch([
      this.#audit('reconnect', actor.principalId, id, null, { success: ok }),
    ]);
    return ok;
  }

  async estimate(
    configurationId: string,
    rawPolicy: EmbeddingSchedulePolicyV1,
    context: AuthorizationContext,
  ): Promise<{ planId: string; estimate: EmbeddingEstimateV1 }> {
    const actor = this.#admin(context);
    const config = await this.#config(
      token(configurationId, 'configurationId', 128),
    );
    const policy = normalizePolicy(rawPolicy);
    const corpus = await this.#corpus();
    const tokens = corpus.reduce(
      (sum, record) => sum + estimateTokens(record.text),
      0,
    );
    const batches = Math.ceil(corpus.length / this.#batchSize);
    const now = this.#now();
    const pricing = policy.costPerThousandTokensMicrounits;
    const estimate: EmbeddingEstimateV1 = {
      records: new Set(
        corpus.map((record) => `${record.kind}:${record.sourceId}`),
      ).size,
      chunks: corpus.length,
      tokens,
      dimensions: Number(config.dimensions),
      batches,
      earliestStart: now,
      latestFinish: null,
      cost: pricing
        ? {
            minimumMicrounits: Math.ceil((tokens / 1000) * pricing.minimum),
            maximumMicrounits: Math.ceil((tokens / 1000) * pricing.maximum),
          }
        : null,
      assumptions: [
        'UTF-8 text uses a conservative four-characters-per-token estimate',
        'time remains unknown without observed provider throughput',
        ...(pricing ? [] : ['provider pricing is unknown']),
      ],
    };
    const planId = token(this.#createId(), 'planId', 128);
    const statements: SqlitePreparedStatementLike[] = [
      this.#db
        .prepare(
          `INSERT INTO taproot_embedding_plans(plan_id, configuration_id, generation, state, estimate_json, policy_json, principal_id, created_at, updated_at) VALUES (?, ?, ?, 'estimated', ?, ?, ?, ?, ?)`,
        )
        .bind(
          planId,
          config.configuration_id,
          config.active_generation,
          JSON.stringify(estimate),
          JSON.stringify(policy),
          actor.principalId,
          now,
          now,
        ),
      this.#db
        .prepare(
          `INSERT INTO taproot_embedding_generations(configuration_id, generation, state, eligible_count, created_at) VALUES (?, ?, 'planned', ?, ?) ON CONFLICT(configuration_id, generation) DO UPDATE SET eligible_count=excluded.eligible_count`,
        )
        .bind(
          config.configuration_id,
          config.active_generation,
          corpus.length,
          now,
        ),
      ...corpus.map((record) =>
        this.#db
          .prepare(
            `INSERT INTO taproot_embedding_work(plan_id, derived_id, source_revision, content_hash, state, token_count, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(plan_id, derived_id) DO UPDATE SET source_revision=excluded.source_revision, content_hash=excluded.content_hash, state=CASE WHEN taproot_embedding_work.content_hash=excluded.content_hash THEN taproot_embedding_work.state ELSE 'pending' END, token_count=excluded.token_count, updated_at=excluded.updated_at`,
          )
          .bind(
            planId,
            record.id,
            record.sourceRevision,
            record.contentHash,
            estimateTokens(record.text),
            now,
          ),
      ),
      this.#audit(
        'estimate',
        actor.principalId,
        config.configuration_id,
        planId,
        estimate,
      ),
    ];
    await this.#db.batch(statements);
    return { planId, estimate };
  }

  async approve(planId: string, context: AuthorizationContext): Promise<void> {
    const actor = this.#admin(context);
    const id = token(planId, 'planId', 128);
    const now = this.#now();
    await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE taproot_embedding_plans SET state='approved', approved_by=?, approved_at=?, updated_at=? WHERE plan_id=? AND state='estimated'`,
        )
        .bind(actor.principalId, now, now, id),
      this.#audit('approve', actor.principalId, null, id, {}),
    ]);
    const plan = await this.#plan(id);
    if (plan.state !== 'approved') throw new Error('plan is not approvable');
  }

  run(
    planId: string,
    context: AuthorizationContext,
    signal?: AbortSignal,
  ): Promise<SemanticAdminStatusV1> {
    return this.#run(planId, context, signal);
  }
  resume(
    planId: string,
    context: AuthorizationContext,
    signal?: AbortSignal,
  ): Promise<SemanticAdminStatusV1> {
    return this.#run(planId, context, signal);
  }

  async pause(planId: string, context: AuthorizationContext): Promise<void> {
    await this.#transitionPlan(
      planId,
      context,
      ['approved', 'running'],
      'paused',
      'pause',
    );
  }
  async stop(planId: string, context: AuthorizationContext): Promise<void> {
    await this.#transitionPlan(
      planId,
      context,
      ['approved', 'running', 'paused', 'failed'],
      'stopped',
      'stop',
    );
  }
  async retry(planId: string, context: AuthorizationContext): Promise<void> {
    const actor = this.#admin(context);
    const id = token(planId, 'planId', 128);
    await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE taproot_embedding_work SET state='pending', failure_code=NULL, updated_at=? WHERE plan_id=? AND state='failed' AND attempt < 3`,
        )
        .bind(this.#now(), id),
      this.#db
        .prepare(
          `UPDATE taproot_embedding_plans SET state='approved', updated_at=? WHERE plan_id=? AND state IN ('failed','paused')`,
        )
        .bind(this.#now(), id),
      this.#audit('retry', actor.principalId, null, id, {}),
    ]);
  }

  async exclude(
    configurationId: string,
    generation: number,
    derivedId: string,
    reason: string,
    context: AuthorizationContext,
  ): Promise<void> {
    const actor = this.#admin(context);
    const id = token(configurationId, 'configurationId', 128);
    const did = token(derivedId, 'derivedId', 256);
    const why = token(reason, 'reason', 512);
    await this.#db.batch([
      this.#db
        .prepare(
          `INSERT INTO taproot_embedding_exclusions(configuration_id, generation, derived_id, reason, principal_id, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(configuration_id, generation, derived_id) DO NOTHING`,
        )
        .bind(
          id,
          positive(generation, 'generation'),
          did,
          why,
          actor.principalId,
          this.#now(),
        ),
      this.#db
        .prepare(
          `UPDATE taproot_embedding_work SET state='excluded', updated_at=? WHERE derived_id=? AND plan_id IN (SELECT plan_id FROM taproot_embedding_plans WHERE configuration_id=? AND generation=?)`,
        )
        .bind(this.#now(), did, id, generation),
      this.#audit('exclude', actor.principalId, id, null, {
        derivedId: did,
        reason: why,
      }),
    ]);
    await this.#refreshReadiness(id, generation);
  }

  async retire(
    configurationId: string,
    context: AuthorizationContext,
  ): Promise<void> {
    const actor = this.#admin(context);
    const id = token(configurationId, 'configurationId', 128);
    await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE taproot_semantic_configurations SET selected=0, state='retired', updated_at=? WHERE installation_id=? AND configuration_id=?`,
        )
        .bind(this.#now(), this.#installationId, id),
      this.#audit('retire', actor.principalId, id, null, {}),
    ]);
  }

  async deleteEmbeddings(
    configurationId: string,
    context: AuthorizationContext,
  ): Promise<void> {
    const actor = this.#admin(context);
    const id = token(configurationId, 'configurationId', 128);
    const binding = this.#bindings.get(id);
    if (!binding) throw new Error('configuration runtime is unavailable');
    await this.#db
      .prepare(
        `UPDATE taproot_semantic_configurations SET selected=0, state='deleting', updated_at=? WHERE installation_id=? AND configuration_id=?`,
      )
      .bind(this.#now(), this.#installationId, id)
      .run();
    await binding.vector.delete({
      installationId: this.#installationId,
      configurationId: id,
    });
    await this.#db.batch([
      this.#db
        .prepare(
          `DELETE FROM taproot_embedding_vectors WHERE installation_id=? AND configuration_id=?`,
        )
        .bind(this.#installationId, id),
      this.#db
        .prepare(
          `UPDATE taproot_semantic_configurations SET state='retired', ready_generation=NULL, updated_at=? WHERE installation_id=? AND configuration_id=?`,
        )
        .bind(this.#now(), this.#installationId, id),
      this.#audit('delete-embeddings', actor.principalId, id, null, {}),
    ]);
  }

  async search(input: {
    text: string;
    kinds: readonly UnifiedSearchKind[];
    limit: number;
    context: AuthorizationContext;
  }): Promise<readonly SemanticSearchCandidateV1[]> {
    const context = normalizeAuthorizationContext(input.context);
    if (context.installationId !== this.#installationId) return [];
    const result = await this.#db
      .prepare(
        `SELECT * FROM taproot_semantic_configurations WHERE installation_id=? AND selected=1`,
      )
      .bind(this.#installationId)
      .all<SemanticRow>();
    const config = result.results[0];
    if (
      !config ||
      config.state !== 'ready' ||
      config.ready_generation !== config.active_generation ||
      config.circuit_open ||
      processCircuits.has(this.#circuitKey(config.configuration_id))
    )
      return [];
    const binding = this.#bindings.get(config.configuration_id);
    if (!binding) return [];
    try {
      const embedded = await retryBounded(
        () => binding.provider.embed([input.text]),
        this.#maxAttempts,
      );
      return await retryBounded(
        () =>
          binding.vector.query(
            {
              installationId: this.#installationId,
              configurationId: config.configuration_id,
              generation: config.active_generation,
              kinds: input.kinds,
              vector: embedded.vectors[0]!,
              limit: input.limit,
              context,
            },
            config.dimensions,
            config.metric,
          ),
        this.#maxAttempts,
      );
    } catch {
      await this.#openCircuit(config.configuration_id, 'runtime-failure');
      return [];
    }
  }

  async status(context: AuthorizationContext): Promise<SemanticAdminStatusV1> {
    this.#admin(context);
    const configs = await this.#db
      .prepare(
        `SELECT configuration_id, selected, state, circuit_open, active_generation, ready_generation FROM taproot_semantic_configurations WHERE installation_id=? ORDER BY configuration_id`,
      )
      .bind(this.#installationId)
      .all<{
        configuration_id: string;
        selected: number;
        state: string;
        circuit_open: number;
        active_generation: number;
        ready_generation: number | null;
      }>();
    const plans = await this.#db
      .prepare(
        `SELECT p.plan_id, p.state, p.generation, SUM(CASE WHEN w.state='pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN w.state='complete' THEN 1 ELSE 0 END) AS complete, SUM(CASE WHEN w.state='failed' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN w.state='excluded' THEN 1 ELSE 0 END) AS excluded, COALESCE(SUM(u.estimated_tokens),0) AS estimated_tokens, COALESCE(SUM(u.actual_tokens),0) AS actual_tokens FROM taproot_embedding_plans p LEFT JOIN taproot_embedding_work w ON w.plan_id=p.plan_id LEFT JOIN taproot_embedding_usage u ON u.plan_id=p.plan_id WHERE p.configuration_id IN (SELECT configuration_id FROM taproot_semantic_configurations WHERE installation_id=?) GROUP BY p.plan_id ORDER BY p.created_at`,
      )
      .bind(this.#installationId)
      .all<{
        plan_id: string;
        state: string;
        generation: number;
        pending: number;
        complete: number;
        failed: number;
        excluded: number;
        estimated_tokens: number;
        actual_tokens: number;
      }>();
    const selected = configs.results.find((config) => Boolean(config.selected));
    return {
      configured: configs.results.length,
      selectedConfigurationId: selected?.configuration_id ?? null,
      selectedReady: Boolean(
        selected &&
        selected.state === 'ready' &&
        selected.ready_generation === selected.active_generation,
      ),
      circuitOpen: Boolean(
        selected?.circuit_open ||
        (selected &&
          processCircuits.has(this.#circuitKey(selected.configuration_id))),
      ),
      plans: plans.results.map((plan) => ({
        planId: plan.plan_id,
        state: plan.state,
        generation: Number(plan.generation),
        pending: Number(plan.pending),
        complete: Number(plan.complete),
        failed: Number(plan.failed),
        excluded: Number(plan.excluded),
        estimatedTokens: Number(plan.estimated_tokens),
        actualTokens: Number(plan.actual_tokens),
      })),
    };
  }

  async #run(
    planId: string,
    context: AuthorizationContext,
    signal?: AbortSignal,
  ): Promise<SemanticAdminStatusV1> {
    const actor = this.#admin(context);
    const id = token(planId, 'planId', 128);
    const plan = await this.#plan(id);
    if (!['approved', 'running', 'paused'].includes(plan.state))
      throw new Error('approved durable plan is required');
    const config = await this.#config(plan.configuration_id);
    const binding = this.#bindings.get(config.configuration_id);
    if (!binding) throw new Error('configuration runtime is unavailable');
    const policy = normalizePolicy(
      JSON.parse(plan.policy_json) as EmbeddingSchedulePolicyV1,
    );
    enforceWindow(policy, this.#clock());
    const corpus = new Map(
      (await this.#corpus()).map((record) => [record.id, record]),
    );
    const existing = await this.#db
      .prepare(`SELECT derived_id FROM taproot_embedding_work WHERE plan_id=?`)
      .bind(id)
      .all<{ derived_id: string }>();
    const removed = existing.results
      .map((row) => row.derived_id)
      .filter((derivedId) => !corpus.has(derivedId));
    const now = this.#now();
    await this.#db.batch([
      ...[...corpus.values()].map((record) =>
        this.#db
          .prepare(
            `INSERT INTO taproot_embedding_work(plan_id, derived_id, source_revision, content_hash, state, token_count, updated_at)
             VALUES (?, ?, ?, ?, 'pending', ?, ?)
             ON CONFLICT(plan_id, derived_id) DO UPDATE SET
               source_revision=excluded.source_revision,
               content_hash=excluded.content_hash,
               state=CASE WHEN taproot_embedding_work.content_hash=excluded.content_hash THEN taproot_embedding_work.state ELSE 'pending' END,
               attempt=CASE WHEN taproot_embedding_work.content_hash=excluded.content_hash THEN taproot_embedding_work.attempt ELSE 0 END,
               failure_code=CASE WHEN taproot_embedding_work.content_hash=excluded.content_hash THEN taproot_embedding_work.failure_code ELSE NULL END,
               token_count=excluded.token_count,
               updated_at=excluded.updated_at`,
          )
          .bind(
            id,
            record.id,
            record.sourceRevision,
            record.contentHash,
            estimateTokens(record.text),
            now,
          ),
      ),
      ...removed.map((derivedId) =>
        this.#db
          .prepare(
            `UPDATE taproot_embedding_work SET state='superseded', updated_at=? WHERE plan_id=? AND derived_id=?`,
          )
          .bind(now, id, derivedId),
      ),
      this.#db
        .prepare(
          `UPDATE taproot_embedding_generations SET eligible_count=? WHERE configuration_id=? AND generation=?`,
        )
        .bind(corpus.size, config.configuration_id, plan.generation),
    ]);
    if (removed.length)
      await retryBounded(
        () =>
          binding.vector.delete({
            installationId: this.#installationId,
            configurationId: config.configuration_id,
            generation: plan.generation,
            ids: removed,
          }),
        this.#maxAttempts,
      );
    await this.#db
      .prepare(
        `UPDATE taproot_embedding_plans SET state='running', updated_at=? WHERE plan_id=? AND state IN ('approved','paused','running')`,
      )
      .bind(this.#now(), id)
      .run();
    await this.#db
      .prepare(
        `UPDATE taproot_embedding_generations SET state='building' WHERE configuration_id=? AND generation=?`,
      )
      .bind(config.configuration_id, plan.generation)
      .run();
    const maxBatches = Math.min(
      policy.maxBatchesPerRun ?? Number.MAX_SAFE_INTEGER,
      10_000,
    );
    let batches = 0;
    while (batches < maxBatches) {
      if (signal?.aborted) break;
      const state = await this.#plan(id);
      if (state.state !== 'running') break;
      const work = await this.#db
        .prepare(
          `SELECT derived_id, source_revision, content_hash, token_count, attempt FROM taproot_embedding_work WHERE plan_id=? AND state='pending' ORDER BY derived_id LIMIT ?`,
        )
        .bind(id, this.#batchSize)
        .all<{
          derived_id: string;
          source_revision: string;
          content_hash: string;
          token_count: number;
          attempt: number;
        }>();
      if (!work.results.length) break;
      const records = work.results
        .map((row) => corpus.get(row.derived_id))
        .filter((record): record is CorpusRecord => Boolean(record));
      const stale = work.results.filter(
        (row) =>
          !corpus.has(row.derived_id) ||
          corpus.get(row.derived_id)!.contentHash !== row.content_hash,
      );
      if (stale.length)
        await this.#db.batch(
          stale.map((row) =>
            this.#db
              .prepare(
                `UPDATE taproot_embedding_work SET state='superseded', updated_at=? WHERE plan_id=? AND derived_id=?`,
              )
              .bind(this.#now(), id, row.derived_id),
          ),
        );
      if (!records.length) continue;
      const estimatedTokens = records.reduce(
        (sum, record) => sum + estimateTokens(record.text),
        0,
      );
      const reservation = reserveCost(policy, estimatedTokens);
      await this.#enforceBudget(id, policy, estimatedTokens, reservation);
      const batchKey = await canonicalSearchHashV1({
        planId: id,
        records: records.map((record) => [record.id, record.contentHash]),
      });
      const usageId = token(this.#createId(), 'usageId', 128);
      const now = this.#clock();
      const inserted = await this.#db
        .prepare(
          `INSERT INTO taproot_embedding_usage(usage_id, plan_id, batch_key, day_key, month_key, estimated_tokens, reserved_cost_microunits, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(plan_id, batch_key) DO NOTHING`,
        )
        .bind(
          usageId,
          id,
          batchKey,
          now.toISOString().slice(0, 10),
          now.toISOString().slice(0, 7),
          estimatedTokens,
          reservation,
          now.toISOString(),
        )
        .run();
      if (!inserted.success) throw new Error('usage reservation failed');
      try {
        const embedded = await retryBounded(
          () =>
            binding.provider.embed(
              records.map((record) => record.text),
              signal,
            ),
          this.#maxAttempts,
        );
        const vectors = records.map((record, index): VectorRecordV1 => ({
          ...record,
          installationId: this.#installationId,
          configurationId: config.configuration_id,
          generation: plan.generation,
          vector: embedded.vectors[index]!,
        }));
        await retryBounded(
          () =>
            binding.vector.upsert(
              vectors,
              config.dimensions,
              config.metric,
              signal,
            ),
          this.#maxAttempts,
        );
        await this.#db.batch([
          ...vectors.map((record) =>
            this.#db
              .prepare(
                `UPDATE taproot_embedding_work SET state='complete', attempt=attempt+1, failure_code=NULL, updated_at=? WHERE plan_id=? AND derived_id=? AND content_hash=?`,
              )
              .bind(this.#now(), id, record.id, record.contentHash),
          ),
          this.#db
            .prepare(
              `UPDATE taproot_embedding_usage SET actual_tokens=?, actual_cost_microunits=? WHERE plan_id=? AND batch_key=? AND actual_tokens IS NULL`,
            )
            .bind(
              embedded.usage.tokens,
              embedded.usage.tokens === null
                ? null
                : actualCost(policy, embedded.usage.tokens),
              id,
              batchKey,
            ),
        ]);
      } catch {
        await this.#db.batch(
          records.map((record) =>
            this.#db
              .prepare(
                `UPDATE taproot_embedding_work SET state=CASE WHEN attempt+1>=3 THEN 'failed' ELSE 'pending' END, attempt=attempt+1, failure_code='adapter-failure', updated_at=? WHERE plan_id=? AND derived_id=?`,
              )
              .bind(this.#now(), id, record.id),
          ),
        );
        await this.#openCircuit(config.configuration_id, 'batch-failure');
        await this.#db
          .prepare(
            `UPDATE taproot_embedding_plans SET state='failed', updated_at=? WHERE plan_id=?`,
          )
          .bind(this.#now(), id)
          .run();
        break;
      }
      batches += 1;
    }
    await this.#refreshReadiness(config.configuration_id, plan.generation);
    await this.#db.batch([
      this.#audit('run', actor.principalId, config.configuration_id, id, {
        batches,
      }),
    ]);
    return this.status(context);
  }

  async #validate(
    configurationId: string,
    actor: AuthorizationContext,
  ): Promise<boolean> {
    const config = await this.#config(configurationId);
    const binding = this.#bindings.get(configurationId);
    if (!binding) return false;
    await this.#db
      .prepare(
        `UPDATE taproot_semantic_configurations SET state='validating', updated_at=? WHERE configuration_id=?`,
      )
      .bind(this.#now(), configurationId)
      .run();
    try {
      const probe = await retryBounded(
        () => binding.provider.embed(['taproot isolated semantic probe']),
        this.#maxAttempts,
      );
      validateVector(probe.vectors[0]!, config.dimensions);
      await retryBounded(
        () => binding.vector.validate(config.dimensions, config.metric),
        this.#maxAttempts,
      );
      const probeId = `taproot-probe-${this.#createId()}`;
      await retryBounded(async () => {
        await binding.vector.upsert(
          [
            {
              id: probeId,
              installationId: this.#installationId,
              configurationId,
              generation: config.active_generation,
              kind: 'item',
              sourceId: '__taproot_probe__',
              sourceRevision: 'probe',
              documentId: probeId,
              chunkId: null,
              contentHash: '0'.repeat(64),
              authorization: { version: 1, clauses: [] },
              selector: null,
              vector: probe.vectors[0]!,
            },
          ],
          config.dimensions,
          config.metric,
        );
        await binding.vector.delete({
          installationId: this.#installationId,
          configurationId,
          generation: config.active_generation,
          ids: [probeId],
        });
      }, this.#maxAttempts);
      processCircuits.delete(this.#circuitKey(configurationId));
      await this.#db.batch([
        this.#db
          .prepare(
            `UPDATE taproot_semantic_configurations SET state=CASE WHEN ready_generation=active_generation THEN 'ready' ELSE 'building' END, circuit_open=0, warning_emitted=0, failure_code=NULL, updated_at=? WHERE configuration_id=?`,
          )
          .bind(this.#now(), configurationId),
        this.#audit('validate', actor.principalId, configurationId, null, {
          success: true,
        }),
      ]);
      return true;
    } catch {
      await this.#openCircuit(configurationId, 'validation-failure');
      return false;
    }
  }

  async #openCircuit(configurationId: string, code: string): Promise<void> {
    processCircuits.add(this.#circuitKey(configurationId));
    const row = await this.#db
      .prepare(
        `SELECT warning_emitted FROM taproot_semantic_configurations WHERE configuration_id=? AND installation_id=?`,
      )
      .bind(configurationId, this.#installationId)
      .all<{ warning_emitted: number }>();
    await this.#db
      .prepare(
        `UPDATE taproot_semantic_configurations SET circuit_open=1, warning_emitted=1, failure_code=?, state='failed', updated_at=? WHERE configuration_id=? AND installation_id=?`,
      )
      .bind(code, this.#now(), configurationId, this.#installationId)
      .run();
    if (!row.results[0]?.warning_emitted)
      this.#warn(
        `Taproot semantic configuration ${configurationId} is unavailable; lexical search remains active (${code})`,
      );
  }

  async #refreshReadiness(
    configurationId: string,
    generation: number,
  ): Promise<void> {
    const counts = await this.#db
      .prepare(
        `SELECT SUM(CASE WHEN state='complete' THEN 1 ELSE 0 END) AS complete, SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN state='excluded' THEN 1 ELSE 0 END) AS excluded, SUM(CASE WHEN state IN ('pending','leased') THEN 1 ELSE 0 END) AS pending FROM taproot_embedding_work WHERE plan_id IN (SELECT plan_id FROM taproot_embedding_plans WHERE configuration_id=? AND generation=?)`,
      )
      .bind(configurationId, generation)
      .all<{
        complete: number;
        failed: number;
        excluded: number;
        pending: number;
      }>();
    const count = counts.results[0] ?? {
      complete: 0,
      failed: 0,
      excluded: 0,
      pending: 0,
    };
    const ready = Number(count.pending) === 0 && Number(count.failed) === 0;
    await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE taproot_embedding_generations SET state=?, embedded_count=?, excluded_count=?, failed_count=?, ready_at=? WHERE configuration_id=? AND generation=?`,
        )
        .bind(
          ready ? 'ready' : 'building',
          Number(count.complete),
          Number(count.excluded),
          Number(count.failed),
          ready ? this.#now() : null,
          configurationId,
          generation,
        ),
      this.#db
        .prepare(
          `UPDATE taproot_semantic_configurations SET state=CASE WHEN ? THEN 'ready' ELSE 'building' END, ready_generation=CASE WHEN ? THEN ? ELSE NULL END, updated_at=? WHERE configuration_id=? AND active_generation=? AND circuit_open=0`,
        )
        .bind(
          ready ? 1 : 0,
          ready ? 1 : 0,
          generation,
          this.#now(),
          configurationId,
          generation,
        ),
      this.#db
        .prepare(
          `UPDATE taproot_embedding_plans SET state=CASE WHEN ? THEN 'complete' ELSE state END, updated_at=? WHERE configuration_id=? AND generation=? AND state='running'`,
        )
        .bind(ready ? 1 : 0, this.#now(), configurationId, generation),
    ]);
  }

  async #corpus(): Promise<CorpusRecord[]> {
    const result = await this.#db
      .prepare(
        `SELECT d.document_kind, d.document_id, d.document_slot, d.document_hash, d.document_text, c.chunk_id, c.chunk_hash, c.chunk_text, c.trace_json, h.root_id, h.root_revision, d.stage_id FROM taproot_search_installation_state i JOIN taproot_search_materialization_heads h ON h.corpus_id=i.active_corpus_id AND h.eligible=1 JOIN taproot_unified_search_source_registry r ON r.installation_id=i.installation_id AND r.source_kind=h.root_kind AND r.source_id=h.root_id AND r.current_event_id=h.source_event_id AND r.operation='upsert' JOIN taproot_search_staged_documents d ON d.stage_id=h.current_stage_id LEFT JOIN taproot_search_chunks c ON c.stage_id=d.stage_id AND c.document_slot=d.document_slot WHERE i.installation_id=? AND d.document_kind IN ('item','task','memory','prompt','resource','annotation') ORDER BY d.document_kind,h.root_id,d.document_slot,c.ordinal`,
      )
      .bind(this.#installationId)
      .all<{
        document_kind: Exclude<UnifiedSearchKind, 'statement'>;
        document_id: string;
        document_slot: string;
        document_hash: string;
        document_text: string;
        chunk_id: string | null;
        chunk_hash: string | null;
        chunk_text: string | null;
        trace_json: string | null;
        root_id: string;
        root_revision: string;
        stage_id: string;
      }>();
    const records: CorpusRecord[] = [];
    for (const row of result.results)
      records.push({
        id: row.chunk_id ?? row.document_id,
        kind: row.document_kind,
        sourceId: row.root_id,
        sourceRevision: row.root_revision,
        documentId: row.document_id,
        chunkId: row.chunk_id,
        contentHash: row.chunk_hash ?? row.document_hash,
        text: row.chunk_text ?? row.document_text,
        authorization: await this.#scope(row.stage_id, row.document_slot),
        selector: row.trace_json ? JSON.parse(row.trace_json) : null,
      });
    return records;
  }

  async #scope(
    stageId: string,
    documentSlot: string,
  ): Promise<VisibilityScopeV1> {
    const rows = await this.#db
      .prepare(
        `SELECT c.clause_ordinal,a.atom_kind,a.atom_value FROM taproot_search_document_clauses c JOIN taproot_search_document_atoms a ON a.stage_id=c.stage_id AND a.document_slot=c.document_slot AND a.clause_ordinal=c.clause_ordinal WHERE c.stage_id=? AND c.document_slot=? ORDER BY c.clause_ordinal,a.atom_ordinal`,
      )
      .bind(stageId, documentSlot)
      .all<{
        clause_ordinal: number;
        atom_kind: VisibilityAtomV1['kind'];
        atom_value: string | null;
      }>();
    const clauses = new Map<number, VisibilityAtomV1[]>();
    for (const row of rows.results) {
      const atom: VisibilityAtomV1 =
        row.atom_kind === 'public'
          ? { kind: 'public' }
          : row.atom_kind === 'principal'
            ? { kind: 'principal', principalId: row.atom_value! }
            : row.atom_kind === 'workspace'
              ? { kind: 'workspace', workspaceId: row.atom_value! }
              : { kind: 'capability', capability: row.atom_value! };
      const list = clauses.get(Number(row.clause_ordinal)) ?? [];
      list.push(atom);
      clauses.set(Number(row.clause_ordinal), list);
    }
    return {
      version: 1,
      clauses: [...clauses].sort(([a], [b]) => a - b).map(([, value]) => value),
    };
  }

  async #enforceBudget(
    planId: string,
    policy: EmbeddingSchedulePolicyV1,
    tokens: number,
    reservation: number | null,
  ): Promise<void> {
    if (
      policy.maxTokensPerMinute !== undefined &&
      tokens > policy.maxTokensPerMinute
    )
      throw new Error('batch exceeds throughput policy');
    if (
      (policy.dailySpendMicrounits !== undefined ||
        policy.monthlySpendMicrounits !== undefined) &&
      reservation === null
    )
      throw new Error('hard spend policy requires a reliable cost bound');
    const now = this.#clock().toISOString();
    const usage = await this.#db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN day_key=? THEN reserved_cost_microunits ELSE 0 END),0) AS daily, COALESCE(SUM(CASE WHEN month_key=? THEN reserved_cost_microunits ELSE 0 END),0) AS monthly FROM taproot_embedding_usage WHERE plan_id=?`,
      )
      .bind(now.slice(0, 10), now.slice(0, 7), planId)
      .all<{ daily: number; monthly: number }>();
    const row = usage.results[0];
    if (
      policy.dailySpendMicrounits !== undefined &&
      Number(row?.daily ?? 0) + reservation! > policy.dailySpendMicrounits
    )
      throw new Error('daily spend limit exhausted');
    if (
      policy.monthlySpendMicrounits !== undefined &&
      Number(row?.monthly ?? 0) + reservation! > policy.monthlySpendMicrounits
    )
      throw new Error('monthly spend limit exhausted');
  }

  async #transitionPlan(
    planId: string,
    context: AuthorizationContext,
    from: string[],
    to: string,
    action: string,
  ): Promise<void> {
    const actor = this.#admin(context);
    const id = token(planId, 'planId', 128);
    await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE taproot_embedding_plans SET state=?, updated_at=? WHERE plan_id=? AND state IN (${from.map(() => '?').join(',')})`,
        )
        .bind(to, this.#now(), id, ...from),
      this.#audit(action, actor.principalId, null, id, {}),
    ]);
  }
  async #config(id: string): Promise<SemanticRow> {
    const result = await this.#db
      .prepare(
        `SELECT * FROM taproot_semantic_configurations WHERE installation_id=? AND configuration_id=?`,
      )
      .bind(this.#installationId, id)
      .all<SemanticRow>();
    if (!result.results[0]) throw new Error('semantic configuration not found');
    return result.results[0];
  }
  async #plan(id: string): Promise<{
    plan_id: string;
    configuration_id: string;
    generation: number;
    state: string;
    policy_json: string;
  }> {
    const result = await this.#db
      .prepare(
        `SELECT plan_id,configuration_id,generation,state,policy_json FROM taproot_embedding_plans WHERE plan_id=? AND configuration_id IN (SELECT configuration_id FROM taproot_semantic_configurations WHERE installation_id=?)`,
      )
      .bind(id, this.#installationId)
      .all<{
        plan_id: string;
        configuration_id: string;
        generation: number;
        state: string;
        policy_json: string;
      }>();
    if (!result.results[0]) throw new Error('embedding plan not found');
    return result.results[0];
  }
  #admin(raw: AuthorizationContext): AuthorizationContext {
    const context = normalizeAuthorizationContext(raw);
    if (
      context.installationId !== this.#installationId ||
      !context.capabilities.includes(SEARCH_ADMIN_CAPABILITY)
    )
      throw new Error('search:admin is required');
    return context;
  }
  #audit(
    action: string,
    principalId: string,
    configurationId: string | null,
    planId: string | null,
    details: unknown,
  ): SqlitePreparedStatementLike {
    return this.#db
      .prepare(
        `INSERT INTO taproot_semantic_admin_audit(audit_id,installation_id,configuration_id,plan_id,action,principal_id,details_json,created_at) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .bind(
        token(this.#createId(), 'auditId', 128),
        this.#installationId,
        configurationId,
        planId,
        action,
        principalId,
        JSON.stringify(details),
        this.#now(),
      );
  }
  #now(): string {
    return this.#clock().toISOString();
  }
  #circuitKey(id: string): string {
    return `${this.#installationId}:${id}`;
  }
}

async function boundedFetch(
  fetcher: typeof fetch,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetcher(url, {
      ...init,
      signal: controller.signal,
      redirect: 'error',
    });
    const length = response.headers.get('content-length');
    if (length && Number(length) > maxBytes)
      throw new Error('adapter response exceeds bound');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes)
      throw new Error('adapter response exceeds bound');
    return {
      ok: response.ok,
      status: response.status,
      text: new TextDecoder().decode(bytes),
    };
  } catch (cause) {
    throw redactedAdapterError(
      cause instanceof DOMException && cause.name === 'AbortError'
        ? 'adapter request timed out or was cancelled'
        : 'adapter request failed',
    );
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', abort);
  }
}

function safeEndpoint(value: string, allowPrivate: boolean): URL {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error('adapter endpoint is invalid');
  const host = url.hostname.toLowerCase();
  const privateHost =
    host === 'localhost' ||
    host === '::1' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./u.test(host) ||
    host.startsWith('169.254.') ||
    host.endsWith('.local');
  if (privateHost && !allowPrivate)
    throw new Error('private adapter endpoint requires explicit opt-in');
  if (url.protocol !== 'https:' && !allowPrivate)
    throw new Error('remote adapter endpoint must use HTTPS');
  return url;
}

function normalizeVectors(
  value: unknown,
  count: number,
  dimensions: number,
): number[][] {
  if (!Array.isArray(value) || value.length !== count)
    throw new Error('embedding response count mismatch');
  return value.map((vector) => {
    if (!Array.isArray(vector))
      throw new Error('embedding response vector is invalid');
    const values = vector.map(Number);
    validateVector(values, dimensions);
    return values;
  });
}
function validateVector(vector: readonly number[], dimensions: number): void {
  if (
    !Array.isArray(vector) ||
    vector.length !== dimensions ||
    vector.some((value) => !Number.isFinite(value))
  )
    throw new Error('vector dimensions or values are invalid');
}
function validateVectorRecord(
  record: VectorRecordV1,
  dimensions: number,
  metric: VectorMetricV1,
): void {
  token(record.id, 'vectorId', 512);
  token(record.installationId, 'installationId', 128);
  token(record.configurationId, 'configurationId', 128);
  positive(record.generation, 'generation');
  if (!UNIFIED_SEARCH_KINDS.includes(record.kind))
    throw new Error('semantic kind is invalid');
  validateVector(record.vector, dimensions);
  normalizeMetric(metric);
}
function normalizeMetric(metric: VectorMetricV1): VectorMetricV1 {
  if (!['cosine', 'dot', 'euclid'].includes(metric))
    throw new Error('vector metric is invalid');
  return metric;
}
function similarity(
  left: readonly number[],
  right: readonly number[],
  metric: VectorMetricV1,
): number {
  if (left.length !== right.length)
    throw new Error('vector dimensions mismatch');
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  let distance = 0;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i]!;
    const b = right[i]!;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
    distance += (a - b) ** 2;
  }
  if (metric === 'dot') return dot;
  if (metric === 'euclid') return 1 / (1 + Math.sqrt(distance));
  return leftNorm === 0 || rightNorm === 0
    ? 0
    : dot / Math.sqrt(leftNorm * rightNorm);
}
async function retryBounded<T>(
  operation: () => Promise<T>,
  attempts: number,
): Promise<T> {
  let error: unknown;
  for (let attempt = 0; attempt < Math.min(3, attempts); attempt += 1) {
    try {
      return await operation();
    } catch (cause) {
      error = cause;
    }
  }
  throw error instanceof Error ? error : new Error('adapter operation failed');
}
function normalizePolicy(
  value: EmbeddingSchedulePolicyV1,
): EmbeddingSchedulePolicyV1 {
  if (!value || !['asap', 'window'].includes(value.mode))
    throw new Error('schedule mode is invalid');
  if (
    value.mode === 'window' &&
    (!value.window ||
      !Number.isInteger(value.window.startHourUtc) ||
      !Number.isInteger(value.window.endHourUtc) ||
      value.window.startHourUtc < 0 ||
      value.window.startHourUtc > 23 ||
      value.window.endHourUtc < 0 ||
      value.window.endHourUtc > 23)
  )
    throw new Error('schedule window is invalid');
  for (const field of [
    'maxBatchesPerRun',
    'maxTokensPerMinute',
    'dailySpendMicrounits',
    'monthlySpendMicrounits',
  ] as const)
    if (value[field] !== undefined) positive(value[field], field);
  if (
    value.costPerThousandTokensMicrounits &&
    (value.costPerThousandTokensMicrounits.minimum < 0 ||
      value.costPerThousandTokensMicrounits.maximum <
        value.costPerThousandTokensMicrounits.minimum)
  )
    throw new Error('cost assumption is invalid');
  return JSON.parse(JSON.stringify(value)) as EmbeddingSchedulePolicyV1;
}
function enforceWindow(policy: EmbeddingSchedulePolicyV1, now: Date): void {
  if (policy.mode !== 'window') return;
  const hour = now.getUTCHours();
  const window = policy.window!;
  const allowed =
    window.startHourUtc <= window.endHourUtc
      ? hour >= window.startHourUtc && hour < window.endHourUtc
      : hour >= window.startHourUtc || hour < window.endHourUtc;
  if (!allowed) throw new Error('schedule is outside its time window');
}
function reserveCost(
  policy: EmbeddingSchedulePolicyV1,
  tokens: number,
): number | null {
  return policy.costPerThousandTokensMicrounits
    ? Math.ceil(
        (tokens / 1000) * policy.costPerThousandTokensMicrounits.maximum,
      )
    : null;
}
function actualCost(
  policy: EmbeddingSchedulePolicyV1,
  tokens: number,
): number | null {
  return policy.costPerThousandTokensMicrounits
    ? Math.ceil(
        (tokens / 1000) * policy.costPerThousandTokensMicrounits.maximum,
      )
    : null;
}
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil([...text].length / 4));
}
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
function positive(
  value: number,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error(`${name} is invalid`);
  return value;
}
function token(value: unknown, name: string, max: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error(`${name} is invalid`);
  return value;
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
async function qdrantPointId(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(value)),
  );
  const hex = [...digest.slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function redactedAdapterError(message: string): Error {
  return new Error(message);
}
