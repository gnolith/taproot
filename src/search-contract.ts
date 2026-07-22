import {
  InvalidSearchContractError,
  MixedSearchProjectionScopeError,
  SearchProjectionLimitError,
  UnsupportedSearchProjectionError,
} from './errors.js';
import {
  PersistedEntityAuthorizationSource,
  intersectVisibilityScopes,
  normalizeAuthorizationContext,
  normalizeVisibilityScope,
} from './authorization.js';
import type {
  AuthorizationContext,
  Item,
  PropertyId,
  Statement,
  VisibilityScopeV1,
} from './types.js';

export const UNIFIED_SEARCH_KINDS = [
  'statement',
  'item',
  'task',
  'memory',
  'prompt',
  'resource',
  'annotation',
] as const;

export type UnifiedSearchKind = (typeof UNIFIED_SEARCH_KINDS)[number];

export const UNIFIED_SEARCH_LIMITS = Object.freeze({
  defaultPageSize: 20,
  maxPageSize: 100,
  maxQueryBytes: 4096,
  maxFilterValues: 100,
  maxOpaqueValueBytes: 512,
  maxCursorBytes: 8192,
  maxMatchesPerResult: 64,
  maxProjectionTextBytes: 1_800_000,
  defaultChunkBytes: 4096,
  minChunkBytes: 4,
  maxChunkBytes: 65_536,
  maxChunksPerDocument: 512,
});

export interface StatementSearchFiltersV1 {
  predicateIds: readonly string[];
}

export interface ItemSearchFiltersV1 {
  typeIds: readonly string[];
}

export interface TaskSearchFiltersV1 {
  statuses: readonly string[];
}

export interface ResourceSearchFiltersV1 {
  mediaTypes: readonly string[];
}

export interface UnifiedSearchFiltersV1 {
  languages: readonly string[];
  sourceRevisions: readonly string[];
  byKind: Readonly<{
    statement?: StatementSearchFiltersV1;
    item?: ItemSearchFiltersV1;
    task?: TaskSearchFiltersV1;
    resource?: ResourceSearchFiltersV1;
  }>;
}

export interface UnifiedSearchRequestV1 {
  version: 1;
  text: string;
  kinds: readonly UnifiedSearchKind[];
  filters: UnifiedSearchFiltersV1;
  limit: number;
  cursor: string | null;
}

export type UnifiedSearchReferenceV1 =
  | { kind: 'statement'; itemId: string; statementId: string }
  | { kind: 'item'; itemId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'memory'; memoryId: string }
  | { kind: 'prompt'; promptId: string }
  | { kind: 'resource'; resourceId: string }
  | { kind: 'annotation'; annotationId: string };

export interface UnifiedSearchMatchV1 {
  version: 1;
  field: string;
  language: string | null;
  start: number;
  end: number;
}

export interface UnifiedSearchResultV1 {
  version: 1;
  kind: UnifiedSearchKind;
  sourceRevision: string;
  documentId: string;
  chunkId: string | null;
  reference: UnifiedSearchReferenceV1;
  matches: readonly UnifiedSearchMatchV1[];
}

export interface UnifiedSearchPageV1 {
  version: 1;
  results: readonly UnifiedSearchResultV1[];
  nextCursor: string | null;
}

export const UNIFIED_SEARCH_ERROR_CODES = [
  'invalid_request',
  'invalid_cursor',
  'stale_cursor',
  'unsupported_kind',
  'authorization_denied',
  'temporarily_unavailable',
  'internal_error',
] as const;

export type UnifiedSearchErrorCode =
  (typeof UNIFIED_SEARCH_ERROR_CODES)[number];

export interface UnifiedSearchErrorV1 {
  version: 1;
  code: UnifiedSearchErrorCode;
  message: string;
  retryable: boolean;
}

export interface UnifiedSearchCursorBindingV1 {
  version: 1;
  requestHash: string;
  authorizationFingerprint: string;
  installationId: string;
  authorizationRevision: number;
  searchGeneration: number;
}

export type SearchProjectionOperationV1 = 'upsert' | 'delete';

export interface SearchProjectionSourceEventV1 {
  version: 1;
  eventId: string;
  operation: SearchProjectionOperationV1;
  installationId: string;
  kind: UnifiedSearchKind;
  sourceId: string;
  sourceRevision: string;
  sourceHash: string;
  authorizationRevision: number;
  searchGeneration: number;
}

export interface SearchAuthorizationEnvelopeValueV1 {
  version: 1;
  sourceKind: UnifiedSearchKind;
  sourceId: string;
  sourceRevision: string;
  installationId: string;
  workspaceId: string | null;
  ownerPrincipalId: string;
  authorizationRevision: number;
  visibility: VisibilityScopeV1;
  fingerprint: string;
}

export interface TrustedSearchAuthorizationEnvelopeV1 {
  readonly kind: 'taproot-trusted-search-authorization-v1';
}

export interface SearchProjectionAuthorizationAuthorityV1 {
  readonly kind: 'taproot-search-projection-authorization-authority-v1';
}

export type SearchProjectionFieldV1 =
  'label' | 'alias' | 'description' | 'type' | 'statement';

export interface SearchProjectionSegmentV1 {
  field: SearchProjectionFieldV1;
  sourceId: string;
  language: string | null;
  text: string;
  documentStart: number;
  documentEnd: number;
}

export interface DerivedSearchDocumentV1 {
  version: 1;
  projectionVersion: 'taproot-unified-search-projection-v1';
  id: string;
  hash: string;
  kind: 'statement' | 'item';
  source: SearchProjectionSourceEventV1;
  authorization: SearchAuthorizationEnvelopeValueV1;
  partition: number;
  text: string;
  segments: readonly SearchProjectionSegmentV1[];
}

export interface SearchChunkTraceV1 {
  field: SearchProjectionFieldV1;
  sourceId: string;
  language: string | null;
  documentStart: number;
  documentEnd: number;
  chunkStart: number;
  chunkEnd: number;
}

export interface DerivedSearchChunkV1 {
  version: 1;
  id: string;
  hash: string;
  documentId: string;
  ordinal: number;
  canonical: false;
  text: string;
  documentStart: number;
  documentEnd: number;
  trace: readonly SearchChunkTraceV1[];
}

export interface SearchProjectionPlanV1 {
  version: 1;
  id: string;
  hash: string;
  source: SearchProjectionSourceEventV1;
  documents: readonly DerivedSearchDocumentV1[];
  chunks: readonly DerivedSearchChunkV1[];
  removeDocumentIds: readonly string[];
}

export type DerivedSearchDocument = DerivedSearchDocumentV1;
export type DerivedSearchChunk = DerivedSearchChunkV1;
export type ProjectionPlan = SearchProjectionPlanV1;
export type ProjectionSourceEvent = SearchProjectionSourceEventV1;

export interface StatementProjectionInputV1 {
  source: SearchProjectionSourceEventV1;
  itemId: string;
  statement: Statement;
  authorization: TrustedSearchAuthorizationEnvelopeV1;
  maxChunkBytes?: number;
}

export interface ItemProjectionInputV1 {
  source: SearchProjectionSourceEventV1;
  item: Item;
  authorization: TrustedSearchAuthorizationEnvelopeV1;
  statementAuthorizations: Readonly<
    Record<string, TrustedSearchAuthorizationEnvelopeV1>
  >;
  mixedScope: 'partition' | 'reject';
  maxChunkBytes?: number;
}

const encoder = new TextEncoder();
const kindOrder = new Map<string, number>(
  UNIFIED_SEARCH_KINDS.map((kind, index) => [kind, index]),
);
const errorCodes = new Set<string>(UNIFIED_SEARCH_ERROR_CODES);
const languagePattern = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u;
const itemPattern = /^Q[1-9][0-9]*$/u;
const propertyPattern = /^P[1-9][0-9]*$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const trustedAuthorization = new WeakMap<
  object,
  SearchAuthorizationEnvelopeValueV1
>();
const projectionAuthorities = new WeakSet<object>();

export function normalizeUnifiedSearchRequestV1(
  value: unknown,
): UnifiedSearchRequestV1 {
  const input = record(value, 'search request');
  exactKeys(input, ['version', 'text', 'kinds', 'filters', 'limit', 'cursor']);
  if (input.version !== 1) invalid('search request version must be 1');
  const text = boundedText(
    input.text,
    'text',
    UNIFIED_SEARCH_LIMITS.maxQueryBytes,
  );
  const kinds =
    input.kinds === undefined
      ? [...UNIFIED_SEARCH_KINDS]
      : normalizeKinds(input.kinds);
  const filters = normalizeUnifiedSearchFiltersV1(input.filters, kinds);
  const limit =
    input.limit === undefined
      ? UNIFIED_SEARCH_LIMITS.defaultPageSize
      : boundedInteger(
          input.limit,
          'limit',
          1,
          UNIFIED_SEARCH_LIMITS.maxPageSize,
        );
  const cursor = nullableBoundedString(
    input.cursor,
    'cursor',
    UNIFIED_SEARCH_LIMITS.maxCursorBytes,
  );
  return { version: 1, text, kinds, filters, limit, cursor };
}

export function normalizeUnifiedSearchFiltersV1(
  value: unknown,
  kinds: readonly UnifiedSearchKind[],
): UnifiedSearchFiltersV1 {
  if (value === undefined)
    return { languages: [], sourceRevisions: [], byKind: {} };
  const input = record(value, 'filters');
  exactKeys(input, ['languages', 'sourceRevisions', 'byKind']);
  const languages = normalizeStringCollection(
    input.languages,
    'languages',
    (candidate) => languagePattern.test(candidate),
  );
  const sourceRevisions = normalizeStringCollection(
    input.sourceRevisions,
    'sourceRevisions',
  );
  const byKindInput =
    input.byKind === undefined ? {} : record(input.byKind, 'filters.byKind');
  exactKeys(byKindInput, ['statement', 'item', 'task', 'resource']);
  const selectedKinds = new Set(kinds);
  const byKind: {
    statement?: StatementSearchFiltersV1;
    item?: ItemSearchFiltersV1;
    task?: TaskSearchFiltersV1;
    resource?: ResourceSearchFiltersV1;
  } = {};
  for (const kind of ['statement', 'item', 'task', 'resource'] as const) {
    const block = byKindInput[kind];
    if (block === undefined) continue;
    if (!selectedKinds.has(kind))
      invalid(`filters.byKind.${kind} requires ${kind} in kinds`);
    const normalizedBlock = record(block, `filters.byKind.${kind}`);
    const field =
      kind === 'statement'
        ? 'predicateIds'
        : kind === 'item'
          ? 'typeIds'
          : kind === 'task'
            ? 'statuses'
            : 'mediaTypes';
    exactKeys(normalizedBlock, [field]);
    const pattern =
      kind === 'statement'
        ? (candidate: string) => propertyPattern.test(candidate)
        : kind === 'item'
          ? (candidate: string) => itemPattern.test(candidate)
          : undefined;
    const values = normalizeStringCollection(
      normalizedBlock[field],
      `filters.byKind.${kind}.${field}`,
      pattern,
    );
    if (kind === 'statement') byKind.statement = { predicateIds: values };
    else if (kind === 'item') byKind.item = { typeIds: values };
    else if (kind === 'task') byKind.task = { statuses: values };
    else byKind.resource = { mediaTypes: values };
  }
  return { languages, sourceRevisions, byKind };
}

export function normalizeUnifiedSearchMatchV1(
  value: unknown,
): UnifiedSearchMatchV1 {
  const input = record(value, 'search match');
  exactKeys(input, ['version', 'field', 'language', 'start', 'end']);
  if (input.version !== 1) invalid('search match version must be 1');
  const field = identifier(input.field, 'field');
  const language =
    input.language === null
      ? null
      : normalizedLanguage(input.language, 'language');
  const start = boundedInteger(
    input.start,
    'start',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const end = boundedInteger(input.end, 'end', start, Number.MAX_SAFE_INTEGER);
  return { version: 1, field, language, start, end };
}

export function normalizeUnifiedSearchResultV1(
  value: unknown,
): UnifiedSearchResultV1 {
  const input = record(value, 'search result');
  exactKeys(input, [
    'version',
    'kind',
    'sourceRevision',
    'documentId',
    'chunkId',
    'reference',
    'matches',
  ]);
  if (input.version !== 1) invalid('search result version must be 1');
  const kind = normalizeKind(input.kind, 'kind');
  const sourceRevision = opaque(input.sourceRevision, 'sourceRevision');
  const documentId = identifier(input.documentId, 'documentId');
  const chunkId =
    input.chunkId === null ? null : identifier(input.chunkId, 'chunkId');
  const reference = normalizeReference(input.reference, kind);
  if (!Array.isArray(input.matches)) invalid('matches must be an array');
  if (input.matches.length > UNIFIED_SEARCH_LIMITS.maxMatchesPerResult)
    invalid(`matches exceeds ${UNIFIED_SEARCH_LIMITS.maxMatchesPerResult}`);
  const matches = input.matches.map(normalizeUnifiedSearchMatchV1);
  return {
    version: 1,
    kind,
    sourceRevision,
    documentId,
    chunkId,
    reference,
    matches,
  };
}

export function normalizeUnifiedSearchPageV1(
  value: unknown,
): UnifiedSearchPageV1 {
  const input = record(value, 'search page');
  exactKeys(input, ['version', 'results', 'nextCursor']);
  if (input.version !== 1) invalid('search page version must be 1');
  if (!Array.isArray(input.results)) invalid('results must be an array');
  if (input.results.length > UNIFIED_SEARCH_LIMITS.maxPageSize)
    invalid(`results exceeds ${UNIFIED_SEARCH_LIMITS.maxPageSize}`);
  const results = input.results.map(normalizeUnifiedSearchResultV1);
  const nextCursor = nullableBoundedString(
    input.nextCursor,
    'nextCursor',
    UNIFIED_SEARCH_LIMITS.maxCursorBytes,
  );
  return { version: 1, results, nextCursor };
}

export function normalizeUnifiedSearchErrorV1(
  value: unknown,
): UnifiedSearchErrorV1 {
  const input = record(value, 'search error');
  exactKeys(input, ['version', 'code', 'message', 'retryable']);
  if (input.version !== 1) invalid('search error version must be 1');
  if (typeof input.code !== 'string' || !errorCodes.has(input.code))
    invalid('search error code is unsupported');
  const message = boundedText(input.message, 'message', 1024);
  if (typeof input.retryable !== 'boolean')
    invalid('retryable must be boolean');
  return {
    version: 1,
    code: input.code as UnifiedSearchErrorCode,
    message,
    retryable: input.retryable,
  };
}

export function normalizeUnifiedSearchCursorBindingV1(
  value: unknown,
): UnifiedSearchCursorBindingV1 {
  const input = record(value, 'cursor binding');
  exactKeys(input, [
    'version',
    'requestHash',
    'authorizationFingerprint',
    'installationId',
    'authorizationRevision',
    'searchGeneration',
  ]);
  if (input.version !== 1) invalid('cursor binding version must be 1');
  return {
    version: 1,
    requestHash: sha256(input.requestHash, 'requestHash'),
    authorizationFingerprint: sha256(
      input.authorizationFingerprint,
      'authorizationFingerprint',
    ),
    installationId: identifier(input.installationId, 'installationId'),
    authorizationRevision: revision(
      input.authorizationRevision,
      'authorizationRevision',
    ),
    searchGeneration: revision(input.searchGeneration, 'searchGeneration'),
  };
}

export async function createUnifiedSearchCursorBindingV1(
  request: unknown,
  authorization: AuthorizationContext,
  searchGeneration: number,
): Promise<UnifiedSearchCursorBindingV1> {
  const normalizedRequest = normalizeUnifiedSearchRequestV1(request);
  const context = normalizeAuthorizationContext(authorization);
  const requestForBinding = { ...normalizedRequest, cursor: null };
  const requestHash = await canonicalSearchHashV1(requestForBinding);
  const authorizationFingerprint = await canonicalSearchHashV1({
    version: 1,
    installationId: context.installationId,
    principalId: context.principalId,
    activeWorkspaceId: context.activeWorkspaceId,
    workspaceIds: context.workspaceIds,
    capabilities: context.capabilities,
  });
  return normalizeUnifiedSearchCursorBindingV1({
    version: 1,
    requestHash,
    authorizationFingerprint,
    installationId: context.installationId,
    authorizationRevision: context.authorizationRevision,
    searchGeneration,
  });
}

export function canonicalSearchBytesV1(value: unknown): Uint8Array {
  return encoder.encode(canonicalJson(value));
}

export async function canonicalSearchHashV1(value: unknown): Promise<string> {
  const bytes = canonicalSearchBytesV1(value);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  return hex(new Uint8Array(digest));
}

export async function deriveSearchContractIdV1(
  namespace: 'document' | 'chunk' | 'plan',
  identity: unknown,
): Promise<string> {
  return `taproot:${namespace}:v1:${await canonicalSearchHashV1({ version: 1, namespace, identity })}`;
}

export function normalizeSearchProjectionSourceEventV1(
  value: unknown,
): SearchProjectionSourceEventV1 {
  const input = record(value, 'projection source event');
  exactKeys(input, [
    'version',
    'eventId',
    'operation',
    'installationId',
    'kind',
    'sourceId',
    'sourceRevision',
    'sourceHash',
    'authorizationRevision',
    'searchGeneration',
  ]);
  if (input.version !== 1) invalid('projection source event version must be 1');
  if (input.operation !== 'upsert' && input.operation !== 'delete')
    invalid('projection operation is unsupported');
  return {
    version: 1,
    eventId: identifier(input.eventId, 'eventId'),
    operation: input.operation,
    installationId: identifier(input.installationId, 'installationId'),
    kind: normalizeKind(input.kind, 'kind'),
    sourceId: identifier(input.sourceId, 'sourceId'),
    sourceRevision: opaque(input.sourceRevision, 'sourceRevision'),
    sourceHash: sha256(input.sourceHash, 'sourceHash'),
    authorizationRevision: revision(
      input.authorizationRevision,
      'authorizationRevision',
    ),
    searchGeneration: revision(input.searchGeneration, 'searchGeneration'),
  };
}

/**
 * Creates a process-local authority only from Taproot's concrete persisted
 * policy source. Request, MCP, prompt, and stored content values cannot forge
 * this opaque object.
 */
export function createSearchProjectionAuthorizationAuthorityV1(
  source: PersistedEntityAuthorizationSource,
): SearchProjectionAuthorizationAuthorityV1 {
  if (!(source instanceof PersistedEntityAuthorizationSource))
    invalid('Taproot persisted authorization source is required');
  const authority = Object.freeze({
    kind: 'taproot-search-projection-authorization-authority-v1' as const,
  });
  projectionAuthorities.add(authority);
  return authority;
}

export async function createTrustedSearchAuthorizationEnvelopeV1(
  authority: SearchProjectionAuthorizationAuthorityV1,
  value: unknown,
): Promise<TrustedSearchAuthorizationEnvelopeV1> {
  if (!isRecord(authority) || !projectionAuthorities.has(authority))
    invalid('host-created search projection authority is required');
  const input = record(value, 'trusted search authorization');
  exactKeys(input, [
    'version',
    'sourceKind',
    'sourceId',
    'sourceRevision',
    'installationId',
    'workspaceId',
    'ownerPrincipalId',
    'authorizationRevision',
    'visibility',
  ]);
  if (input.version !== 1)
    invalid('trusted search authorization version must be 1');
  const normalized = {
    version: 1 as const,
    sourceKind: normalizeKind(input.sourceKind, 'sourceKind'),
    sourceId: identifier(input.sourceId, 'sourceId'),
    sourceRevision: opaque(input.sourceRevision, 'sourceRevision'),
    installationId: identifier(input.installationId, 'installationId'),
    workspaceId:
      input.workspaceId === null
        ? null
        : identifier(input.workspaceId, 'workspaceId'),
    ownerPrincipalId: identifier(input.ownerPrincipalId, 'ownerPrincipalId'),
    authorizationRevision: revision(
      input.authorizationRevision,
      'authorizationRevision',
    ),
    visibility: normalizeVisibilityScope(input.visibility as VisibilityScopeV1),
  };
  const complete: SearchAuthorizationEnvelopeValueV1 = {
    ...normalized,
    fingerprint: await authorizationFingerprint(normalized),
  };
  const envelope = Object.freeze({
    kind: 'taproot-trusted-search-authorization-v1' as const,
  });
  trustedAuthorization.set(envelope, complete);
  return envelope;
}

export async function projectStatementForUnifiedSearchV1(
  input: StatementProjectionInputV1,
): Promise<SearchProjectionPlanV1> {
  const source = normalizeSearchProjectionSourceEventV1(input.source);
  if (source.operation !== 'upsert' || source.kind !== 'statement')
    invalid('statement projection requires a statement upsert source event');
  const itemId = checkedItemId(input.itemId, 'itemId');
  validateStatementProjection(input.statement, itemId);
  if (source.sourceId !== input.statement.id)
    invalid('statement source id does not match the statement');
  const authorization = authorizationFor(
    input.authorization,
    source,
    'statement',
    input.statement.id,
  );
  const projectionSegment = segment(
    'statement',
    input.statement.id,
    null,
    input.statement.text,
  );
  const document = await buildDocument('statement', source, authorization, 0, [
    projectionSegment,
  ]);
  const chunks = await chunkDocument(
    document,
    normalizeChunkBytes(input.maxChunkBytes),
  );
  return buildPlan(source, [document], chunks);
}

export async function projectItemForUnifiedSearchV1(
  input: ItemProjectionInputV1,
): Promise<SearchProjectionPlanV1> {
  const source = normalizeSearchProjectionSourceEventV1(input.source);
  if (source.operation !== 'upsert' || source.kind !== 'item')
    invalid('item projection requires an item upsert source event');
  if (
    input.item.type !== 'item' ||
    checkedItemId(input.item.id, 'item.id') !== source.sourceId
  )
    invalid('item source id does not match the Item');
  boundedInteger(
    input.item.lastrevid,
    'item.lastrevid',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (`${input.item.lastrevid}` !== source.sourceRevision)
    invalid('item source revision does not match lastrevid');
  if (input.mixedScope !== 'partition' && input.mixedScope !== 'reject')
    invalid('mixedScope must be partition or reject');
  const itemAuthorization = authorizationFor(
    input.authorization,
    source,
    'item',
    input.item.id,
  );
  const statements = orderedStatements(input.item);
  for (const statement of statements)
    validateStatementProjection(statement, input.item.id);
  const expectedIds = statements.map((statement) => statement.id).sort(compare);
  const providedIds = Object.keys(input.statementAuthorizations).sort(compare);
  if (JSON.stringify(expectedIds) !== JSON.stringify(providedIds))
    invalid('statementAuthorizations must exactly cover current statements');

  const groups = new Map<
    string,
    {
      authorization: SearchAuthorizationEnvelopeValueV1;
      segments: SearchProjectionSegmentV1[];
    }
  >();
  groups.set(itemAuthorization.fingerprint, {
    authorization: itemAuthorization,
    segments: itemMetadataSegments(input.item),
  });

  for (const statement of statements) {
    const statementAuthorization = authorizationFor(
      input.statementAuthorizations[statement.id],
      source,
      'statement',
      statement.id,
    );
    const effective = await intersectAuthorization(
      itemAuthorization,
      statementAuthorization,
    );
    if (
      input.mixedScope === 'reject' &&
      effective.fingerprint !== itemAuthorization.fingerprint
    )
      throw new MixedSearchProjectionScopeError(
        `Item ${input.item.id} contains mixed authorization scopes`,
      );
    const group = groups.get(effective.fingerprint) ?? {
      authorization: effective,
      segments: [],
    };
    group.segments.push(
      segment('statement', statement.id, null, statement.text),
    );
    groups.set(effective.fingerprint, group);
  }

  const orderedGroups = [...groups.values()]
    .filter(({ segments }) => segments.length > 0)
    .sort((left, right) =>
      compare(left.authorization.fingerprint, right.authorization.fingerprint),
    );
  if (orderedGroups.length === 0)
    invalid(`Item ${input.item.id} has no projectable text`);
  const documents: DerivedSearchDocumentV1[] = [];
  const chunks: DerivedSearchChunkV1[] = [];
  const maxChunkBytes = normalizeChunkBytes(input.maxChunkBytes);
  for (const [partition, group] of orderedGroups.entries()) {
    const document = await buildDocument(
      'item',
      source,
      group.authorization,
      partition,
      group.segments,
    );
    documents.push(document);
    chunks.push(...(await chunkDocument(document, maxChunkBytes)));
  }
  return buildPlan(source, documents, chunks);
}

export function projectTaskForUnifiedSearchV1(): never {
  return unsupportedProjection('task');
}

export function projectMemoryForUnifiedSearchV1(): never {
  return unsupportedProjection('memory');
}

export function projectPromptForUnifiedSearchV1(): never {
  return unsupportedProjection('prompt');
}

export function projectResourceForUnifiedSearchV1(): never {
  return unsupportedProjection('resource');
}

export function projectAnnotationForUnifiedSearchV1(): never {
  return unsupportedProjection('annotation');
}

function unsupportedProjection(kind: UnifiedSearchKind): never {
  throw new UnsupportedSearchProjectionError(
    `${kind} projection is recognized by contract V1 but is not implemented`,
  );
}

function normalizeKinds(value: unknown): UnifiedSearchKind[] {
  if (!Array.isArray(value) || value.length === 0)
    invalid('kinds must be a non-empty array when provided');
  const unique = new Set<UnifiedSearchKind>();
  for (const candidate of value) unique.add(normalizeKind(candidate, 'kinds'));
  return [...unique].sort(
    (left, right) => kindOrder.get(left)! - kindOrder.get(right)!,
  );
}

function normalizeKind(value: unknown, name: string): UnifiedSearchKind {
  if (typeof value !== 'string' || !kindOrder.has(value))
    invalid(`${name} is not a unified search kind`);
  return value as UnifiedSearchKind;
}

function normalizeReference(
  value: unknown,
  expectedKind: UnifiedSearchKind,
): UnifiedSearchReferenceV1 {
  const input = record(value, 'reference');
  const kind = normalizeKind(input.kind, 'reference.kind');
  if (kind !== expectedKind)
    invalid('reference kind does not match result kind');
  switch (kind) {
    case 'statement':
      exactKeys(input, ['kind', 'itemId', 'statementId']);
      return {
        kind,
        itemId: checkedItemId(input.itemId, 'reference.itemId'),
        statementId: identifier(input.statementId, 'reference.statementId'),
      };
    case 'item':
      exactKeys(input, ['kind', 'itemId']);
      return { kind, itemId: checkedItemId(input.itemId, 'reference.itemId') };
    case 'task':
      exactKeys(input, ['kind', 'taskId']);
      return { kind, taskId: identifier(input.taskId, 'reference.taskId') };
    case 'memory':
      exactKeys(input, ['kind', 'memoryId']);
      return {
        kind,
        memoryId: identifier(input.memoryId, 'reference.memoryId'),
      };
    case 'prompt':
      exactKeys(input, ['kind', 'promptId']);
      return {
        kind,
        promptId: identifier(input.promptId, 'reference.promptId'),
      };
    case 'resource':
      exactKeys(input, ['kind', 'resourceId']);
      return {
        kind,
        resourceId: identifier(input.resourceId, 'reference.resourceId'),
      };
    case 'annotation':
      exactKeys(input, ['kind', 'annotationId']);
      return {
        kind,
        annotationId: identifier(input.annotationId, 'reference.annotationId'),
      };
  }
}

function normalizeStringCollection(
  value: unknown,
  name: string,
  validate?: (candidate: string) => boolean,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid(`${name} must be an array`);
  if (value.length > UNIFIED_SEARCH_LIMITS.maxFilterValues)
    invalid(`${name} exceeds ${UNIFIED_SEARCH_LIMITS.maxFilterValues} values`);
  const unique = new Set<string>();
  for (const raw of value) {
    const candidate = opaque(raw, name);
    if (validate && !validate(candidate))
      invalid(`${name} contains an invalid value`);
    unique.add(candidate);
  }
  return [...unique].sort(compare);
}

function normalizeChunkBytes(value: unknown): number {
  return value === undefined
    ? UNIFIED_SEARCH_LIMITS.defaultChunkBytes
    : boundedInteger(
        value,
        'maxChunkBytes',
        UNIFIED_SEARCH_LIMITS.minChunkBytes,
        UNIFIED_SEARCH_LIMITS.maxChunkBytes,
      );
}

function authorizationFor(
  envelope: TrustedSearchAuthorizationEnvelopeV1 | undefined,
  source: SearchProjectionSourceEventV1,
  sourceKind: UnifiedSearchKind,
  sourceId: string,
): SearchAuthorizationEnvelopeValueV1 {
  if (!envelope || !isRecord(envelope))
    invalid('a trusted search authorization envelope is required');
  const authorization = trustedAuthorization.get(envelope);
  if (!authorization)
    invalid('search authorization envelope was not created by Taproot');
  if (
    authorization.sourceKind !== sourceKind ||
    authorization.sourceId !== sourceId ||
    authorization.sourceRevision !== source.sourceRevision ||
    authorization.authorizationRevision !== source.authorizationRevision ||
    authorization.installationId !== source.installationId
  )
    invalid('search authorization envelope does not match the source event');
  return authorization;
}

async function intersectAuthorization(
  item: SearchAuthorizationEnvelopeValueV1,
  statement: SearchAuthorizationEnvelopeValueV1,
): Promise<SearchAuthorizationEnvelopeValueV1> {
  if (
    item.installationId !== statement.installationId ||
    item.sourceRevision !== statement.sourceRevision ||
    item.authorizationRevision !== statement.authorizationRevision
  )
    invalid('statement authorization is not in the Item authorization domain');
  const visibility = intersectVisibilityScopes(
    item.visibility,
    statement.visibility,
  );
  const normalized = {
    ...statement,
    sourceKind: 'item' as const,
    sourceId: item.sourceId,
    workspaceId: item.workspaceId,
    ownerPrincipalId: item.ownerPrincipalId,
    visibility,
  };
  return {
    ...normalized,
    fingerprint: await authorizationFingerprint(normalized),
  };
}

function itemMetadataSegments(item: Item): SearchProjectionSegmentV1[] {
  const segments: SearchProjectionSegmentV1[] = [];
  for (const language of Object.keys(item.labels).sort(compare)) {
    const value = item.labels[language];
    if (value) segments.push(segment('label', item.id, language, value.value));
  }
  for (const language of Object.keys(item.aliases).sort(compare)) {
    for (const [ordinal, value] of (item.aliases[language] ?? []).entries())
      segments.push(
        segment(
          'alias',
          `${item.id}:alias:${language}:${ordinal}`,
          language,
          value.value,
        ),
      );
  }
  for (const language of Object.keys(item.descriptions).sort(compare)) {
    const value = item.descriptions[language];
    if (value)
      segments.push(segment('description', item.id, language, value.value));
  }
  for (const typeId of itemTypeIds(item))
    segments.push(segment('type', typeId, null, typeId));
  return segments;
}

function itemTypeIds(item: Item): string[] {
  const ids = new Set<string>();
  for (const statement of item.claims.P31 ?? []) {
    const value = statement.mainsnak.datavalue?.value;
    if (
      typeof value === 'object' &&
      value !== null &&
      'id' in value &&
      typeof value.id === 'string' &&
      itemPattern.test(value.id)
    )
      ids.add(value.id);
  }
  return [...ids].sort(compare);
}

function orderedStatements(item: Item): Statement[] {
  return (Object.keys(item.claims) as PropertyId[])
    .sort(compare)
    .flatMap((property) =>
      [...(item.claims[property] ?? [])].sort((left, right) =>
        compare(left.id, right.id),
      ),
    );
}

function validateStatementProjection(
  statement: Statement,
  itemId: string,
): void {
  if (
    !isRecord(statement) ||
    statement.type !== 'statement' ||
    typeof statement.id !== 'string' ||
    !statement.id.startsWith(`${itemId}$`)
  )
    invalid('statement is not a logical statement owned by the Item');
  boundedText(
    statement.text,
    'statement.text',
    UNIFIED_SEARCH_LIMITS.maxProjectionTextBytes,
  );
}

function segment(
  field: SearchProjectionFieldV1,
  sourceId: string,
  language: string | null,
  text: string,
): SearchProjectionSegmentV1 {
  const normalizedText = boundedText(
    text,
    `${field}.text`,
    UNIFIED_SEARCH_LIMITS.maxProjectionTextBytes,
  );
  return {
    field,
    sourceId: identifier(sourceId, `${field}.sourceId`),
    language:
      language === null
        ? null
        : normalizedLanguage(language, `${field}.language`),
    text: normalizedText,
    documentStart: 0,
    documentEnd: 0,
  };
}

async function buildDocument(
  kind: 'statement' | 'item',
  source: SearchProjectionSourceEventV1,
  authorization: SearchAuthorizationEnvelopeValueV1,
  partition: number,
  rawSegments: readonly SearchProjectionSegmentV1[],
): Promise<DerivedSearchDocumentV1> {
  const segments: SearchProjectionSegmentV1[] = [];
  let text = '';
  for (const raw of rawSegments) {
    const documentStart = text.length;
    if (text.length > 0) text += '\n';
    text += raw.text;
    segments.push({ ...raw, documentStart, documentEnd: text.length });
  }
  const identity = {
    projectionVersion: 'taproot-unified-search-projection-v1',
    kind,
    source: {
      kind: source.kind,
      sourceId: source.sourceId,
      sourceRevision: source.sourceRevision,
      sourceHash: source.sourceHash,
      installationId: source.installationId,
    },
    authorizationFingerprint: authorization.fingerprint,
    partition,
  };
  const id = await deriveSearchContractIdV1('document', identity);
  const payload = {
    version: 1 as const,
    projectionVersion: 'taproot-unified-search-projection-v1' as const,
    id,
    kind,
    source,
    authorization,
    partition,
    text,
    segments,
  };
  return { ...payload, hash: await canonicalSearchHashV1(payload) };
}

async function chunkDocument(
  document: DerivedSearchDocumentV1,
  maxChunkBytes: number,
): Promise<DerivedSearchChunkV1[]> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  let end = 0;
  let bytes = 0;
  for (const codePoint of document.text) {
    const codePointBytes = encoder.encode(codePoint).byteLength;
    if (bytes > 0 && bytes + codePointBytes > maxChunkBytes) {
      ranges.push({ start, end });
      start = end;
      bytes = 0;
    }
    if (codePointBytes > maxChunkBytes)
      throw new SearchProjectionLimitError(
        'one Unicode scalar exceeds maxChunkBytes',
      );
    end += codePoint.length;
    bytes += codePointBytes;
  }
  if (end > start || document.text.length === 0) ranges.push({ start, end });
  if (ranges.length > UNIFIED_SEARCH_LIMITS.maxChunksPerDocument)
    throw new SearchProjectionLimitError(
      `projection exceeds ${UNIFIED_SEARCH_LIMITS.maxChunksPerDocument} chunks`,
    );
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

async function buildPlan(
  source: SearchProjectionSourceEventV1,
  documents: readonly DerivedSearchDocumentV1[],
  chunks: readonly DerivedSearchChunkV1[],
): Promise<SearchProjectionPlanV1> {
  const removeDocumentIds: string[] = [];
  const id = await deriveSearchContractIdV1('plan', {
    source,
    documentIds: documents.map(({ id: documentId }) => documentId),
    chunkIds: chunks.map(({ id: chunkId }) => chunkId),
    removeDocumentIds,
  });
  const payload = {
    version: 1 as const,
    id,
    source,
    documents,
    chunks,
    removeDocumentIds,
  };
  return { ...payload, hash: await canonicalSearchHashV1(payload) };
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      invalid('canonical search values require finite numbers');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1)
      if (!Object.hasOwn(value, index))
        invalid('canonical search arrays must be dense');
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (!isRecord(value))
    invalid('canonical search values must be JSON-compatible');
  const normalizedKeys = new Map<string, string>();
  for (const key of Object.keys(value)) {
    const normalized = key.normalize('NFC');
    if (normalizedKeys.has(normalized))
      invalid('canonical search object has duplicate NFC keys');
    normalizedKeys.set(normalized, key);
  }
  return `{${[...normalizedKeys.entries()]
    .sort(([left], [right]) => compare(left, right))
    .map(
      ([normalized, original]) =>
        `${JSON.stringify(normalized)}:${canonicalJson(value[original])}`,
    )
    .join(',')}}`;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) invalid(`unknown field ${unknown.sort(compare)[0]}`);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${name} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== 'string') invalid(`${name} must be a string`);
  const normalized = value.normalize('NFC');
  if (normalized.trim().length === 0) invalid(`${name} must be nonblank`);
  if (encoder.encode(normalized).byteLength > maxBytes)
    invalid(`${name} exceeds ${maxBytes} UTF-8 bytes`);
  return normalized;
}

function nullableBoundedString(
  value: unknown,
  name: string,
  maxBytes: number,
): string | null {
  if (value === undefined || value === null) return null;
  return boundedText(value, name, maxBytes);
}

function opaque(value: unknown, name: string): string {
  return boundedText(value, name, UNIFIED_SEARCH_LIMITS.maxOpaqueValueBytes);
}

function identifier(value: unknown, name: string): string {
  return opaque(value, name);
}

function normalizedLanguage(value: unknown, name: string): string {
  const language = opaque(value, name);
  if (!languagePattern.test(language)) invalid(`${name} is not a language tag`);
  return language;
}

function checkedItemId(value: unknown, name: string): string {
  const id = identifier(value, name);
  if (!itemPattern.test(id)) invalid(`${name} must be a positive Q id`);
  return id;
}

function revision(value: unknown, name: string): number {
  return boundedInteger(value, name, 1, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  )
    invalid(`${name} must be an integer from ${minimum} through ${maximum}`);
  return Number(value);
}

function sha256(value: unknown, name: string): string {
  if (typeof value !== 'string' || !sha256Pattern.test(value))
    invalid(`${name} must be a lowercase SHA-256 hex digest`);
  return value;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function authorizationFingerprint(value: {
  installationId: string;
  workspaceId: string | null;
  ownerPrincipalId: string;
  authorizationRevision: number;
  visibility: VisibilityScopeV1;
}): Promise<string> {
  return canonicalSearchHashV1({
    version: 1,
    installationId: value.installationId,
    workspaceId: value.workspaceId,
    ownerPrincipalId: value.ownerPrincipalId,
    authorizationRevision: value.authorizationRevision,
    visibility: value.visibility,
  });
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function invalid(message: string): never {
  throw new InvalidSearchContractError(message);
}
