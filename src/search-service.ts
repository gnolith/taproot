import type { SqliteDatabaseLike } from './sqlite-types.js';
import { isVisibleTo, normalizeAuthorizationContext } from './authorization.js';
import type { TaprootContentRepositoryV1 } from './content-domain.js';
import { lookupExternalSearchProducerRuntimeInternalV1 } from './external-search-producers.js';
import {
  canonicalSearchHashV1,
  createUnifiedSearchCursorBindingV1,
  normalizeUnifiedSearchRequestV1,
  type UnifiedSearchFiltersV1,
  type UnifiedSearchKind,
  type UnifiedSearchReferenceV1,
  UNIFIED_SEARCH_KINDS,
} from './search-contract.js';
import type {
  AuthorizationContext,
  VisibilityAtomV1,
  VisibilityScopeV1,
  WikibaseEntity,
} from './types.js';

export interface SearchRequest {
  text: string;
  kinds?: readonly UnifiedSearchKind[];
  filters?: Record<string, unknown>;
  limit?: number;
  cursor?: string;
}

export interface SearchResultV1 {
  kind: UnifiedSearchKind;
  sourceId: string;
  sourceRevision: string;
  score: number;
  title?: string;
  snippet: string;
  language?: string;
  match?: {
    derivedDocumentId?: string;
    selector?: unknown;
    contributingStatementIds?: string[];
  };
}

export interface SearchPage {
  results: SearchResultV1[];
  cursor?: string;
}

export interface SemanticSearchCandidateV1 {
  derivedId: string;
  score: number;
}

export interface SemanticSearchAugmenterV1 {
  search(input: {
    text: string;
    kinds: readonly UnifiedSearchKind[];
    limit: number;
    context: AuthorizationContext;
  }): Promise<readonly SemanticSearchCandidateV1[]>;
}

export interface AuthorizedSearchServiceOptionsV1 {
  installationId: string;
  content?: TaprootContentRepositoryV1;
  semantic?: SemanticSearchAugmenterV1;
  maxCandidateRows?: number;
}

export interface AuthorizedSearchServiceV1 {
  /** The package's single relevance-search operation. */
  search(
    request: SearchRequest,
    context: AuthorizationContext,
  ): Promise<SearchPage>;
  /** Canonical owner hydration after a result has been selected. */
  hydrate(
    result: SearchResultV1,
    context: AuthorizationContext,
  ): Promise<unknown>;
}

interface CandidateRow {
  document_kind: UnifiedSearchKind;
  document_id: string;
  document_slot: string;
  document_text: string;
  canonical_reference_json: string;
  filter_metadata_json: string;
  chunk_id: string | null;
  chunk_text: string | null;
  trace_json: string | null;
  root_id: string;
  root_revision: string;
  source_policy_revision: number;
  producer_fingerprint: string | null;
  stage_id: string;
}

interface RankedCandidate {
  row: CandidateRow;
  derivedId: string;
  lexicalRank: number | null;
  semanticRank: number | null;
  score: number;
}

interface CursorPayload {
  version: 1;
  bindingHash: string;
  offset: number;
}

const MAX_SNIPPET_CODEPOINTS = 240;
const DEFAULT_MAX_CANDIDATES = 10_000;

export function createAuthorizedSearchServiceV1(
  db: SqliteDatabaseLike,
  options: AuthorizedSearchServiceOptionsV1,
): AuthorizedSearchServiceV1 {
  const runtime = new AuthorizedSearchRuntime(db, options);
  return Object.freeze({
    search: (request: SearchRequest, context: AuthorizationContext) =>
      runtime.search(request, context),
    hydrate: (result: SearchResultV1, context: AuthorizationContext) =>
      runtime.hydrate(result, context),
  });
}

class AuthorizedSearchRuntime {
  readonly #db: SqliteDatabaseLike;
  readonly #installationId: string;
  readonly #content: TaprootContentRepositoryV1 | undefined;
  readonly #semantic: SemanticSearchAugmenterV1 | undefined;
  readonly #maxCandidateRows: number;

  constructor(
    db: SqliteDatabaseLike,
    options: AuthorizedSearchServiceOptionsV1,
  ) {
    this.#db = db;
    this.#installationId = identifier(options.installationId, 'installationId');
    this.#content = options.content;
    this.#semantic = options.semantic;
    this.#maxCandidateRows = options.maxCandidateRows ?? DEFAULT_MAX_CANDIDATES;
    if (
      !Number.isSafeInteger(this.#maxCandidateRows) ||
      this.#maxCandidateRows < 100 ||
      this.#maxCandidateRows > 100_000
    )
      throw new Error('maxCandidateRows is invalid');
  }

  async search(
    rawRequest: SearchRequest,
    rawContext: AuthorizationContext,
  ): Promise<SearchPage> {
    const context = normalizeAuthorizationContext(rawContext);
    if (context.installationId !== this.#installationId)
      throw new Error('authorization denied');
    const request = normalizePublicRequest(rawRequest);
    const state = await this.#state();
    const binding = await createUnifiedSearchCursorBindingV1(
      { ...request, cursor: null },
      context,
      state.search_generation,
    );
    const bindingHash = await canonicalSearchHashV1(binding);
    const offset =
      rawRequest.cursor === undefined
        ? 0
        : decodeCursor(rawRequest.cursor, bindingHash);
    const rows = await this.#candidates(request.kinds);
    const authorized: Array<{ row: CandidateRow; derivedId: string }> = [];
    for (const row of rows) {
      if (!matchesFilters(row, request.filters)) continue;
      const scope = await this.#scope(row.stage_id, row.document_slot);
      if (!isVisibleTo(scope, context)) continue;
      authorized.push({ row, derivedId: row.chunk_id ?? row.document_id });
    }

    const terms = tokenize(request.text);
    const lexical = authorized
      .map(({ row, derivedId }) => ({
        row,
        derivedId,
        lexical: lexicalScore(row, request.text, terms),
      }))
      .filter((candidate) => candidate.lexical > 0)
      .sort(
        (left, right) =>
          right.lexical - left.lexical || compareRows(left.row, right.row),
      );
    const lexicalRanks = new Map(
      lexical.map((candidate, index) => [candidate.derivedId, index + 1]),
    );

    let semanticRanks = new Map<string, number>();
    if (this.#semantic) {
      const semantic = await this.#semantic.search({
        text: request.text,
        kinds: request.kinds,
        limit: Math.min(
          this.#maxCandidateRows,
          Math.max(request.limit * 8, 64),
        ),
        context,
      });
      const allowed = new Set(authorized.map(({ derivedId }) => derivedId));
      semanticRanks = new Map(
        semantic
          .filter(({ derivedId }) => allowed.has(derivedId))
          .sort(
            (left, right) =>
              right.score - left.score ||
              compare(left.derivedId, right.derivedId),
          )
          .map((candidate, index) => [candidate.derivedId, index + 1]),
      );
    }

    const byId = new Map(
      authorized.map((candidate) => [candidate.derivedId, candidate]),
    );
    const included = new Set([...lexicalRanks.keys(), ...semanticRanks.keys()]);
    const ranked: RankedCandidate[] = [...included].map((derivedId) => {
      const candidate = byId.get(derivedId)!;
      const lexicalRank = lexicalRanks.get(derivedId) ?? null;
      const semanticRank = semanticRanks.get(derivedId) ?? null;
      const score = opaqueScore(lexicalRank, semanticRank);
      return { ...candidate, lexicalRank, semanticRank, score };
    });
    ranked.sort(
      (left, right) =>
        right.score - left.score || compareRows(left.row, right.row),
    );
    if (offset > ranked.length) throw new Error('stale cursor');
    const page = ranked
      .slice(offset, offset + request.limit)
      .map((candidate) => toResult(candidate, request.text));
    const nextOffset = offset + page.length;
    return {
      results: page,
      ...(nextOffset < ranked.length
        ? {
            cursor: encodeCursor({
              version: 1,
              bindingHash,
              offset: nextOffset,
            }),
          }
        : {}),
    };
  }

  async hydrate(
    result: SearchResultV1,
    rawContext: AuthorizationContext,
  ): Promise<unknown> {
    const context = normalizeAuthorizationContext(rawContext);
    if (context.installationId !== this.#installationId)
      throw new Error('authorization denied');
    const kind = normalizeKind(result.kind);
    const sourceId = identifier(result.sourceId, 'sourceId');
    const revision = opaque(result.sourceRevision, 'sourceRevision');
    if (kind === 'statement')
      return this.#hydrateKnowledge(kind, sourceId, revision, context);
    const registry = await this.#db
      .prepare(
        `SELECT operation, source_revision, source_policy_revision FROM taproot_unified_search_source_registry WHERE installation_id = ? AND source_kind = ? AND source_id = ?`,
      )
      .bind(this.#installationId, kind, sourceId)
      .all<{
        operation: string;
        source_revision: string;
        source_policy_revision: number;
      }>();
    const current = registry.results[0];
    if (
      !current ||
      current.operation !== 'upsert' ||
      current.source_revision !== revision
    )
      throw new Error('stale search result');
    if (kind === 'resource') {
      if (!this.#content) throw new Error('resource owner is unavailable');
      return this.#content.getResource(sourceId, context);
    }
    if (kind === 'annotation') {
      if (!this.#content) throw new Error('annotation owner is unavailable');
      return this.#content.getAnnotation(sourceId, context);
    }
    if (kind === 'item')
      return this.#hydrateKnowledge(kind, sourceId, revision, context);
    const head = await this.#db
      .prepare(
        `SELECT producer_fingerprint FROM taproot_search_materialization_heads h JOIN taproot_search_installation_state s ON s.active_corpus_id = h.corpus_id WHERE s.installation_id = ? AND h.root_kind = ? AND h.root_id = ? AND h.eligible = 1`,
      )
      .bind(this.#installationId, kind, sourceId)
      .all<{ producer_fingerprint: string | null }>();
    const runtime = lookupExternalSearchProducerRuntimeInternalV1(
      this.#db,
      this.#installationId,
      kind,
      head.results[0]?.producer_fingerprint ?? null,
    );
    if (!runtime) throw new Error('canonical producer is unavailable');
    const authorization = await runtime.callbacks.authorizeCurrentReference(
      runtime.policyAuthority,
      {
        sourceId,
        sourceRevision: revision,
        sourcePolicyRevision: Number(current.source_policy_revision),
      },
    );
    if (!isVisibleTo(authorization.visibility, context))
      throw new Error('authorization denied');
    const hydrated = await runtime.callbacks.hydrateCurrentReference(
      runtime.policyAuthority,
      {
        sourceId,
        sourceRevision: revision,
        sourcePolicyRevision: Number(current.source_policy_revision),
      },
    );
    const loaded = await runtime.callbacks.loadCurrent({
      sourceId,
      expectedSourceRevision: revision,
    });
    if (!loaded || loaded.sourceRevision !== revision)
      throw new Error('stale search result');
    return hydrated;
  }

  async #hydrateKnowledge(
    kind: 'item' | 'statement',
    sourceId: string,
    revision: string,
    context: AuthorizationContext,
  ): Promise<unknown> {
    const entityId =
      kind === 'item'
        ? sourceId
        : sourceId.includes('$')
          ? sourceId.slice(0, sourceId.indexOf('$'))
          : sourceId.split(':', 1)[0]!;
    const result = await this.#db
      .prepare(
        `SELECT e.entity_json, e.revision, a.effective_visibility_json FROM taproot_entities e JOIN taproot_entity_authorization a ON a.entity_id = e.entity_id WHERE e.entity_id = ? AND e.deleted_at IS NULL AND a.deleted_at IS NULL`,
      )
      .bind(entityId)
      .all<{
        entity_json: string;
        revision: number;
        effective_visibility_json: string;
      }>();
    const row = result.results[0];
    if (
      !row ||
      String(row.revision) !== revision ||
      !isVisibleTo(
        JSON.parse(row.effective_visibility_json) as VisibilityScopeV1,
        context,
      )
    )
      throw new Error('stale or unauthorized search result');
    const entity = JSON.parse(row.entity_json) as WikibaseEntity;
    if (kind === 'item') return entity;
    const statementId = sourceId;
    for (const statements of Object.values(entity.claims)) {
      const statement = statements.find(
        (candidate) => candidate.id === statementId,
      );
      if (statement) {
        const policy = await this.#db
          .prepare(
            `SELECT effective_visibility_json
             FROM taproot_statement_authorization
             WHERE entity_id = ? AND source_revision = ? AND statement_id = ?`,
          )
          .bind(entityId, row.revision, statementId)
          .all<{ effective_visibility_json: string }>();
        const scope = policy.results[0]?.effective_visibility_json;
        if (
          !scope ||
          !isVisibleTo(JSON.parse(scope) as VisibilityScopeV1, context)
        )
          throw new Error('authorization denied');
        return statement;
      }
    }
    throw new Error('statement not found');
  }

  async #state(): Promise<{
    active_corpus_id: string;
    search_generation: number;
  }> {
    const result = await this.#db
      .prepare(
        `SELECT s.active_corpus_id, a.search_generation
         FROM taproot_search_installation_state s
         JOIN taproot_installation_authorization a
           ON a.installation_id = s.installation_id
         WHERE s.installation_id = ?`,
      )
      .bind(this.#installationId)
      .all<{ active_corpus_id: string; search_generation: number }>();
    const row = result.results[0];
    if (!row) throw new Error('search is not initialized');
    return row;
  }

  async #candidates(
    kinds: readonly UnifiedSearchKind[],
  ): Promise<CandidateRow[]> {
    const placeholders = kinds.map(() => '?').join(',');
    const result = await this.#db
      .prepare(
        `SELECT d.document_kind, d.document_id, d.document_slot, d.document_text, d.canonical_reference_json, d.filter_metadata_json, c.chunk_id, c.chunk_text, c.trace_json, h.root_id, h.root_revision, h.source_policy_revision, h.producer_fingerprint, d.stage_id FROM taproot_search_installation_state i JOIN taproot_search_materialization_heads h ON h.corpus_id = i.active_corpus_id AND h.eligible = 1 JOIN taproot_unified_search_source_registry r ON r.installation_id = i.installation_id AND r.source_kind = h.root_kind AND r.source_id = h.root_id AND r.current_event_id = h.source_event_id AND r.operation = 'upsert' JOIN taproot_search_staged_documents d ON d.stage_id = h.current_stage_id LEFT JOIN taproot_search_chunks c ON c.stage_id = d.stage_id AND c.document_slot = d.document_slot WHERE i.installation_id = ? AND d.document_kind IN (${placeholders}) ORDER BY d.document_kind, h.root_id, d.document_slot, c.ordinal LIMIT ?`,
      )
      .bind(this.#installationId, ...kinds, this.#maxCandidateRows + 1)
      .all<CandidateRow>();
    if (result.results.length > this.#maxCandidateRows)
      throw new Error('search candidate bound exceeded');
    return result.results;
  }

  async #scope(
    stageId: string,
    documentSlot: string,
  ): Promise<VisibilityScopeV1> {
    const result = await this.#db
      .prepare(
        `SELECT c.clause_ordinal, a.atom_ordinal, a.atom_kind, a.atom_value FROM taproot_search_document_clauses c JOIN taproot_search_document_atoms a ON a.stage_id = c.stage_id AND a.document_slot = c.document_slot AND a.clause_ordinal = c.clause_ordinal WHERE c.stage_id = ? AND c.document_slot = ? ORDER BY c.clause_ordinal, a.atom_ordinal`,
      )
      .bind(stageId, documentSlot)
      .all<{
        clause_ordinal: number;
        atom_ordinal: number;
        atom_kind: VisibilityAtomV1['kind'];
        atom_value: string | null;
      }>();
    const clauses = new Map<number, VisibilityAtomV1[]>();
    for (const row of result.results) {
      const atom: VisibilityAtomV1 =
        row.atom_kind === 'public'
          ? { kind: 'public' }
          : row.atom_kind === 'principal'
            ? { kind: 'principal', principalId: row.atom_value! }
            : row.atom_kind === 'workspace'
              ? { kind: 'workspace', workspaceId: row.atom_value! }
              : { kind: 'capability', capability: row.atom_value! };
      const clause = clauses.get(Number(row.clause_ordinal)) ?? [];
      clause.push(atom);
      clauses.set(Number(row.clause_ordinal), clause);
    }
    return {
      version: 1,
      clauses: [...clauses].sort(([a], [b]) => a - b).map(([, atoms]) => atoms),
    };
  }
}

function normalizePublicRequest(value: SearchRequest) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid search request');
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) => !['text', 'kinds', 'filters', 'limit', 'cursor'].includes(key),
    )
  )
    throw new Error('invalid search request field');
  return normalizeUnifiedSearchRequestV1({
    version: 1,
    text: value.text,
    ...(value.kinds === undefined ? {} : { kinds: value.kinds }),
    ...(value.filters === undefined ? {} : { filters: value.filters }),
    ...(value.limit === undefined ? {} : { limit: value.limit }),
    cursor: value.cursor ?? null,
  });
}

function matchesFilters(
  row: CandidateRow,
  filters: UnifiedSearchFiltersV1,
): boolean {
  const metadata = JSON.parse(
    row.filter_metadata_json,
  ) as UnifiedSearchFiltersV1;
  if (
    filters.languages.length &&
    !filters.languages.some((value) => metadata.languages.includes(value))
  )
    return false;
  if (
    filters.sourceRevisions.length &&
    !filters.sourceRevisions.includes(row.root_revision)
  )
    return false;
  const requested = filters.byKind[
    row.document_kind as keyof typeof filters.byKind
  ] as Record<string, readonly string[]> | undefined;
  const actual = metadata.byKind[
    row.document_kind as keyof typeof metadata.byKind
  ] as Record<string, readonly string[]> | undefined;
  if (requested) {
    for (const [key, values] of Object.entries(requested))
      if (
        values.length &&
        !values.some((value) => actual?.[key]?.includes(value))
      )
        return false;
  }
  return true;
}

function lexicalScore(
  row: CandidateRow,
  rawQuery: string,
  terms: readonly string[],
): number {
  const text = (row.chunk_text ?? row.document_text)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US');
  const query = rawQuery.normalize('NFKC').toLocaleLowerCase('en-US');
  const source = row.root_id.toLocaleLowerCase('en-US');
  let score = source === query ? 1000 : source.includes(query) ? 200 : 0;
  if (text === query) score += 500;
  let all = true;
  for (const term of terms) {
    let count = 0;
    let position = 0;
    while ((position = text.indexOf(term, position)) >= 0 && count < 20) {
      count += 1;
      position += Math.max(1, term.length);
    }
    if (count === 0) all = false;
    score += count * (20 + Math.min(40, term.length));
  }
  if (!all && source !== query && !source.includes(query)) return 0;
  if (all && terms.length > 1) score += 80;
  return score;
}

function opaqueScore(
  lexicalRank: number | null,
  semanticRank: number | null,
): number {
  const lexical = lexicalRank === null ? 0 : 1 / (60 + lexicalRank);
  const semantic = semanticRank === null ? 0 : 1 / (60 + semanticRank);
  return Number((lexical + semantic).toFixed(12));
}

function toResult(candidate: RankedCandidate, query: string): SearchResultV1 {
  const row = candidate.row;
  const text = row.chunk_text ?? row.document_text;
  const trace = row.trace_json
    ? (JSON.parse(row.trace_json) as Array<{
        sourceId?: string;
        language?: string | null;
        chunkStart?: number;
        chunkEnd?: number;
      }>)
    : [];
  const reference = JSON.parse(
    row.canonical_reference_json,
  ) as UnifiedSearchReferenceV1;
  const sourceId = referenceId(reference, row.root_id);
  const language = trace.find((entry) => entry.language)?.language ?? undefined;
  const contributors =
    row.document_kind === 'item'
      ? [
          ...new Set(
            trace
              .map((entry) => entry.sourceId)
              .filter(
                (id): id is string => typeof id === 'string' && id !== sourceId,
              ),
          ),
        ]
      : [];
  const resultTitle = title(text);
  return {
    kind: row.document_kind,
    sourceId,
    sourceRevision: row.root_revision,
    score: candidate.score,
    ...(resultTitle === undefined ? {} : { title: resultTitle }),
    snippet: snippet(text, query),
    ...(language ? { language } : {}),
    match: {
      derivedDocumentId: row.chunk_id ?? row.document_id,
      ...(trace.length ? { selector: trace } : {}),
      ...(contributors.length
        ? { contributingStatementIds: contributors }
        : {}),
    },
  };
}

function referenceId(
  reference: UnifiedSearchReferenceV1,
  fallback: string,
): string {
  switch (reference.kind) {
    case 'statement':
      return reference.statementId;
    case 'item':
      return reference.itemId;
    case 'task':
      return reference.taskId;
    case 'memory':
      return reference.memoryId;
    case 'prompt':
      return reference.promptId;
    case 'resource':
      return reference.resourceId;
    case 'annotation':
      return reference.annotationId;
    default:
      return fallback;
  }
}

function title(text: string): string | undefined {
  const value = text.split(/\r?\n/u, 1)[0]!.trim();
  return value ? [...value].slice(0, 160).join('') : undefined;
}

function snippet(text: string, query: string): string {
  const points = [...text];
  if (points.length <= MAX_SNIPPET_CODEPOINTS) return text;
  const index = text
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .indexOf(query.normalize('NFKC').toLocaleLowerCase('en-US'));
  const prefixPoints = index < 0 ? 0 : [...text.slice(0, index)].length;
  const start = Math.max(
    0,
    prefixPoints - Math.floor(MAX_SNIPPET_CODEPOINTS / 3),
  );
  const end = Math.min(points.length, start + MAX_SNIPPET_CODEPOINTS);
  return `${start ? '…' : ''}${points.slice(start, end).join('')}${end < points.length ? '…' : ''}`;
}

function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')
        .split(/[^\p{L}\p{N}_-]+/u)
        .filter(Boolean),
    ),
  ];
}

function compareRows(left: CandidateRow, right: CandidateRow): number {
  const kind =
    UNIFIED_SEARCH_KINDS.indexOf(left.document_kind) -
    UNIFIED_SEARCH_KINDS.indexOf(right.document_kind);
  return (
    kind ||
    compare(left.root_id, right.root_id) ||
    compare(left.document_slot, right.document_slot) ||
    compare(left.chunk_id ?? '', right.chunk_id ?? '')
  );
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeKind(value: string): UnifiedSearchKind {
  if (!(UNIFIED_SEARCH_KINDS as readonly string[]).includes(value))
    throw new Error('unsupported kind');
  return value as UnifiedSearchKind;
}

function identifier(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error(`${name} is invalid`);
  return value;
}

function opaque(value: unknown, name: string): string {
  return identifier(value, name);
}

function encodeCursor(payload: CursorPayload): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
}

function decodeCursor(cursor: string, bindingHash: string): number {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 8192)
    throw new Error('invalid cursor');
  let payload: CursorPayload;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(cursor)),
    ) as CursorPayload;
  } catch {
    throw new Error('invalid cursor');
  }
  if (
    payload.version !== 1 ||
    payload.bindingHash !== bindingHash ||
    !Number.isSafeInteger(payload.offset) ||
    payload.offset < 0
  )
    throw new Error('stale or invalid cursor');
  return payload.offset;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded =
    value.replace(/-/gu, '+').replace(/_/gu, '/') +
    '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
