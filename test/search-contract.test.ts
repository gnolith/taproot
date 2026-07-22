import { describe, expect, it } from 'vitest';
import {
  InvalidSearchContractError,
  MixedSearchProjectionScopeError,
  SearchProjectionLimitError,
  PersistedEntityAuthorizationSource,
  UNIFIED_SEARCH_KINDS,
  UNIFIED_SEARCH_LIMITS,
  UnsupportedSearchProjectionError,
  canonicalSearchBytesV1,
  canonicalSearchHashV1,
  createTrustedSearchAuthorizationEnvelopeV1,
  createSearchProjectionAuthorizationAuthorityV1,
  createUnifiedSearchCursorBindingV1,
  deriveSearchContractIdV1,
  normalizeSearchProjectionSourceEventV1,
  normalizeUnifiedSearchCursorBindingV1,
  normalizeUnifiedSearchErrorV1,
  normalizeUnifiedSearchMatchV1,
  normalizeUnifiedSearchPageV1,
  normalizeUnifiedSearchRequestV1,
  normalizeUnifiedSearchResultV1,
  projectItemForUnifiedSearchV1,
  projectMemoryForUnifiedSearchV1,
  projectPromptForUnifiedSearchV1,
  projectStatementForUnifiedSearchV1,
  projectTaskForUnifiedSearchV1,
  type AuthorizationContext,
  type Item,
  type PropertyId,
  type Statement,
  type TrustedSearchAuthorizationEnvelopeV1,
  type UnifiedSearchKind,
  type VisibilityScopeV1,
} from '../src/index.js';

const PUBLIC: VisibilityScopeV1 = { version: 1, clauses: [] };
const PRIVATE: VisibilityScopeV1 = {
  version: 1,
  clauses: [[{ kind: 'principal', principalId: 'owner-1' }]],
};
const WORKSPACE: VisibilityScopeV1 = {
  version: 1,
  clauses: [[{ kind: 'workspace', workspaceId: 'workspace-1' }]],
};
const SOURCE_HASH = 'a'.repeat(64);
const PROJECTION_AUTHORITY = createSearchProjectionAuthorizationAuthorityV1(
  new PersistedEntityAuthorizationSource({} as never),
);

describe('unified search V1 contract', () => {
  it('normalizes the exact seven kinds and the established kind-aware filters', () => {
    const all = normalizeUnifiedSearchRequestV1({
      version: 1,
      text: '  kiln  ',
    });
    expect(all.kinds).toEqual(UNIFIED_SEARCH_KINDS);
    expect(all.filters).toEqual({
      languages: [],
      sourceRevisions: [],
      byKind: {},
    });
    expect(all.limit).toBe(20);
    expect(all.cursor).toBeNull();

    const narrowed = normalizeUnifiedSearchRequestV1({
      version: 1,
      text: 'kiln',
      kinds: ['resource', 'statement', 'task', 'item', 'statement'],
      filters: {
        languages: ['fr', 'en', 'en'],
        sourceRevisions: ['opaque:2', 'opaque:1'],
        byKind: {
          statement: { predicateIds: ['P31', 'P2', 'P31'] },
          item: { typeIds: ['Q5', 'Q1'] },
          task: { statuses: ['queued', 'done'] },
          resource: { mediaTypes: ['text/plain', 'application/pdf'] },
        },
      },
      limit: 100,
      cursor: 'opaque-cursor',
    });
    expect(narrowed.kinds).toEqual(['statement', 'item', 'task', 'resource']);
    expect(narrowed.filters).toEqual({
      languages: ['en', 'fr'],
      sourceRevisions: ['opaque:1', 'opaque:2'],
      byKind: {
        statement: { predicateIds: ['P2', 'P31'] },
        item: { typeIds: ['Q1', 'Q5'] },
        task: { statuses: ['done', 'queued'] },
        resource: { mediaTypes: ['application/pdf', 'text/plain'] },
      },
    });
  });

  it('rejects unknown kinds, cross-kind blocks, unknown filters, and exact limit violations', () => {
    for (const candidate of [
      { version: 1, text: 'x', kinds: ['property'] },
      {
        version: 1,
        text: 'x',
        kinds: ['item'],
        filters: { byKind: { statement: { predicateIds: ['P31'] } } },
      },
      {
        version: 1,
        text: 'x',
        filters: { itemIds: ['Q1'] },
      },
      { version: 1, text: 'x', limit: 0 },
      { version: 1, text: 'x', limit: 101 },
      { version: 1, text: 'x', kinds: [] },
    ])
      expect(() => normalizeUnifiedSearchRequestV1(candidate)).toThrow(
        InvalidSearchContractError,
      );
    expect(() =>
      normalizeUnifiedSearchRequestV1({
        version: 1,
        text: 'x'.repeat(UNIFIED_SEARCH_LIMITS.maxQueryBytes + 1),
      }),
    ).toThrow(InvalidSearchContractError);
  });

  it('has deterministic NFC, null, numeric, and key-order canonical vectors', async () => {
    const left = {
      z: null,
      array: [null, -0, '😀'],
      a: 'e\u0301',
    };
    const right = {
      a: 'é',
      array: [null, 0, '😀'],
      z: null,
    };
    const expected = '{"a":"é","array":[null,0,"😀"],"z":null}';
    expect(new TextDecoder().decode(canonicalSearchBytesV1(left))).toBe(
      expected,
    );
    expect(canonicalSearchBytesV1(left)).toEqual(canonicalSearchBytesV1(right));
    expect(await canonicalSearchHashV1(left)).toBe(
      '839f5e84de9e77aec7bac1a321627ee82f2aee240cd39ba0e09af07a77aa1d0e',
    );
    expect(await deriveSearchContractIdV1('document', left)).toBe(
      'taproot:document:v1:aa6b265bd8631279b95ea5137250f8ca127242b3d5353de94bea3049a25577d7',
    );
    expect(await canonicalSearchHashV1(right)).toBe(
      '839f5e84de9e77aec7bac1a321627ee82f2aee240cd39ba0e09af07a77aa1d0e',
    );
    expect(
      await deriveSearchContractIdV1('chunk', {
        documentId: 'document-1',
        ordinal: 0,
        text: 'é',
      }),
    ).toBe(
      'taproot:chunk:v1:df6161666bce8605ab2ebec41705e8e2bf75a3456cfeaf4ca7981ef053431ed7',
    );
    expect(() => canonicalSearchBytesV1({ value: Number.NaN })).toThrow(
      InvalidSearchContractError,
    );
    expect(() => canonicalSearchBytesV1(Array(1))).toThrow(
      InvalidSearchContractError,
    );
    expect(() => canonicalSearchBytesV1([undefined])).toThrow(
      InvalidSearchContractError,
    );
    expect(await canonicalSearchHashV1([])).not.toBe(
      await canonicalSearchHashV1([null]),
    );
  });

  it('normalizes kind-aware results, matches, pages, and public errors strictly', () => {
    expect(
      normalizeUnifiedSearchMatchV1({
        version: 1,
        field: 'statement',
        language: null,
        start: 0,
        end: 4,
      }),
    ).toEqual({
      version: 1,
      field: 'statement',
      language: null,
      start: 0,
      end: 4,
    });
    const result = normalizeUnifiedSearchResultV1({
      version: 1,
      kind: 'statement',
      sourceRevision: 'rev:1',
      documentId: 'document-1',
      chunkId: null,
      reference: { kind: 'statement', itemId: 'Q1', statementId: 'Q1$S1' },
      matches: [],
    });
    expect(
      normalizeUnifiedSearchPageV1({
        version: 1,
        results: [result],
        nextCursor: null,
      }).results,
    ).toEqual([result]);
    expect(
      normalizeUnifiedSearchErrorV1({
        version: 1,
        code: 'stale_cursor',
        message: 'Cursor is stale',
        retryable: false,
      }).code,
    ).toBe('stale_cursor');
    const references = {
      statement: { kind: 'statement', itemId: 'Q1', statementId: 'Q1$S1' },
      item: { kind: 'item', itemId: 'Q1' },
      task: { kind: 'task', taskId: 'task-1' },
      memory: { kind: 'memory', memoryId: 'memory-1' },
      prompt: { kind: 'prompt', promptId: 'prompt-1' },
      resource: { kind: 'resource', resourceId: 'resource-1' },
      annotation: { kind: 'annotation', annotationId: 'annotation-1' },
    } as const;
    for (const kind of UNIFIED_SEARCH_KINDS)
      expect(
        normalizeUnifiedSearchResultV1({
          version: 1,
          kind,
          sourceRevision: 'rev:1',
          documentId: `document-${kind}`,
          chunkId: null,
          reference: references[kind],
          matches: [],
        }).reference.kind,
      ).toBe(kind);
    expect(() =>
      normalizeUnifiedSearchResultV1({
        ...result,
        reference: { kind: 'item', itemId: 'Q1' },
      }),
    ).toThrow(InvalidSearchContractError);
    expect(() =>
      normalizeUnifiedSearchErrorV1({
        version: 1,
        code: 'database_error',
        message: 'leak',
        retryable: false,
      }),
    ).toThrow(InvalidSearchContractError);
  });

  it('binds normalized query, scope, authorization revision, and generation without issuing a cursor', async () => {
    const request = {
      version: 1,
      text: 'e\u0301',
      kinds: ['item', 'statement'],
      filters: { languages: ['fr', 'en'] },
      cursor: 'page-two',
    };
    const context: AuthorizationContext = {
      installationId: 'installation-1',
      principalId: 'principal-1',
      activeWorkspaceId: 'workspace-1',
      workspaceIds: ['workspace-2', 'workspace-1'],
      capabilities: ['search:query', 'knowledge:read'],
      authorizationRevision: 7,
    };
    const first = await createUnifiedSearchCursorBindingV1(request, context, 9);
    const retry = await createUnifiedSearchCursorBindingV1(
      { ...request, text: 'é', cursor: 'different-cursor' },
      { ...context, workspaceIds: ['workspace-1', 'workspace-2'] },
      9,
    );
    expect(retry).toEqual(first);
    expect(
      await createUnifiedSearchCursorBindingV1(
        { ...request, text: 'different' },
        context,
        9,
      ),
    ).not.toEqual(first);
    expect(
      await createUnifiedSearchCursorBindingV1(request, context, 10),
    ).not.toEqual(first);
    expect(normalizeUnifiedSearchCursorBindingV1(first)).toEqual(first);
    expect(() =>
      normalizeUnifiedSearchCursorBindingV1({ ...first, query: 'leak' }),
    ).toThrow(InvalidSearchContractError);
  });
});

describe('pure Taproot Statement and Item projection planning', () => {
  it('projects one logical Statement, preserves trace, and marks chunks noncanonical', async () => {
    const statement = makeStatement('Q1$S1', '🔥 kiln statement text');
    const source = sourceEvent('statement', statement.id, '1');
    const authorization = await envelope(
      'statement',
      statement.id,
      '1',
      PUBLIC,
    );
    const first = await projectStatementForUnifiedSearchV1({
      source,
      itemId: 'Q1',
      statement,
      authorization,
      maxChunkBytes: 8,
    });
    const second = await projectStatementForUnifiedSearchV1({
      source: { ...source },
      itemId: 'Q1',
      statement: { ...statement },
      authorization,
      maxChunkBytes: 8,
    });
    expect(first).toEqual(second);
    expect(first.documents).toHaveLength(1);
    expect(first.documents[0]!.text).toBe(statement.text);
    expect(first.chunks.map(({ text }) => text).join('')).toBe(statement.text);
    expect(first.chunks.every(({ canonical }) => canonical === false)).toBe(
      true,
    );
    expect(first.chunks.flatMap(({ trace }) => trace)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'statement', sourceId: statement.id }),
      ]),
    );
    expect(JSON.stringify(first.documents[0])).not.toContain('mainsnak');
  });

  it('rejects forged envelopes and envelope/source drift', async () => {
    const statement = makeStatement('Q1$S1', 'statement');
    const source = sourceEvent('statement', statement.id, '1');
    await expect(
      createTrustedSearchAuthorizationEnvelopeV1(
        {
          kind: 'taproot-search-projection-authorization-authority-v1',
        },
        {
          version: 1,
          sourceKind: 'statement',
          sourceId: statement.id,
          sourceRevision: '1',
          installationId: 'installation-1',
          workspaceId: null,
          ownerPrincipalId: 'owner-1',
          authorizationRevision: 4,
          visibility: PUBLIC,
        },
      ),
    ).rejects.toBeInstanceOf(InvalidSearchContractError);
    await expect(
      projectStatementForUnifiedSearchV1({
        source,
        itemId: 'Q1',
        statement,
        authorization: {
          kind: 'taproot-trusted-search-authorization-v1',
        },
      }),
    ).rejects.toBeInstanceOf(InvalidSearchContractError);
    const wrongRevision = await envelope(
      'statement',
      statement.id,
      '2',
      PUBLIC,
    );
    await expect(
      projectStatementForUnifiedSearchV1({
        source,
        itemId: 'Q1',
        statement,
        authorization: wrongRevision,
      }),
    ).rejects.toBeInstanceOf(InvalidSearchContractError);
  });

  it('projects all Item metadata, types, and every statement text exactly once without omission', async () => {
    const item = makeItem();
    const source = sourceEvent('item', item.id, `${item.lastrevid}`);
    const authorization = await envelope('item', item.id, '3', PUBLIC);
    const statementAuthorizations = await statementEnvelopeMap(item, PUBLIC);
    const plan = await projectItemForUnifiedSearchV1({
      source,
      item,
      authorization,
      statementAuthorizations,
      mixedScope: 'partition',
      maxChunkBytes: 16,
    });
    expect(plan.documents).toHaveLength(3);
    const text = plan.documents.map(({ text }) => text).join('\n');
    for (const expected of [
      'Kiln',
      'Four',
      'Oven',
      'A very hot kiln',
      'Q5',
      'type statement text',
      'other statement text 🔥',
    ])
      expect(occurrences(text, expected)).toBe(1);
    for (const document of plan.documents)
      expect(
        plan.chunks
          .filter(({ documentId }) => documentId === document.id)
          .map(({ text: chunkText }) => chunkText)
          .join(''),
      ).toBe(document.text);
    expect(
      plan.chunks.every(
        ({ text: chunkText }) =>
          new TextEncoder().encode(chunkText).byteLength <= 16,
      ),
    ).toBe(true);
    expect(
      plan.documents.flatMap(({ segments }) =>
        segments.filter(({ field }) => field === 'statement'),
      ),
    ).toHaveLength(2);
  });

  it('requires exact statement authorization coverage', async () => {
    const item = makeItem();
    await expect(
      projectItemForUnifiedSearchV1({
        source: sourceEvent('item', item.id, '3'),
        item,
        authorization: await envelope('item', item.id, '3', PUBLIC),
        statementAuthorizations: {},
        mixedScope: 'partition',
      }),
    ).rejects.toBeInstanceOf(InvalidSearchContractError);
  });

  it('splits an oversized but valid authored text without omission', async () => {
    const oversizedText = '🔥x'.repeat(120_000);
    const statement = makeStatement('Q1$S1', oversizedText);
    const item: Item = {
      ...makeItem(),
      labels: {},
      aliases: {},
      descriptions: {},
      claims: { P2: [statement] },
    };
    const plan = await projectItemForUnifiedSearchV1({
      source: sourceEvent('item', item.id, '3'),
      item,
      authorization: await envelope('item', item.id, '3', PUBLIC),
      statementAuthorizations: await statementEnvelopeMap(item, PUBLIC),
      mixedScope: 'partition',
    });
    expect(plan.documents[0]!.text).toBe(oversizedText);
    expect(plan.chunks.length).toBeGreaterThan(100);
    expect(plan.chunks.map(({ text }) => text).join('')).toBe(oversizedText);
  });

  it('pins the 1.8MB document and 512-chunk fences without truncation', async () => {
    const exactChunks = makeStatement('Q1$S1', 'x'.repeat(2048));
    const source = sourceEvent('statement', exactChunks.id, '1');
    const authorization = await envelope(
      'statement',
      exactChunks.id,
      '1',
      PUBLIC,
    );
    const plan = await projectStatementForUnifiedSearchV1({
      source,
      itemId: 'Q1',
      statement: exactChunks,
      authorization,
      maxChunkBytes: 4,
    });
    expect(plan.chunks).toHaveLength(512);
    expect(plan.chunks.map(({ text }) => text).join('')).toBe(exactChunks.text);
    const tooMany = makeStatement('Q1$S1', 'x'.repeat(2049));
    await expect(
      projectStatementForUnifiedSearchV1({
        source,
        itemId: 'Q1',
        statement: tooMany,
        authorization,
        maxChunkBytes: 4,
      }),
    ).rejects.toBeInstanceOf(SearchProjectionLimitError);

    const maximum = makeStatement(
      'Q1$S2',
      'x'.repeat(UNIFIED_SEARCH_LIMITS.maxProjectionTextBytes),
    );
    const maximumPlan = await projectStatementForUnifiedSearchV1({
      source: sourceEvent('statement', maximum.id, '1'),
      itemId: 'Q1',
      statement: maximum,
      authorization: await envelope('statement', maximum.id, '1', PUBLIC),
    });
    expect(maximumPlan.documents[0]?.text.length).toBe(
      UNIFIED_SEARCH_LIMITS.maxProjectionTextBytes,
    );
    const tooLarge = makeStatement(
      'Q1$S2',
      'x'.repeat(UNIFIED_SEARCH_LIMITS.maxProjectionTextBytes + 1),
    );
    await expect(
      projectStatementForUnifiedSearchV1({
        source: sourceEvent('statement', tooLarge.id, '1'),
        itemId: 'Q1',
        statement: tooLarge,
        authorization: await envelope('statement', tooLarge.id, '1', PUBLIC),
      }),
    ).rejects.toBeInstanceOf(InvalidSearchContractError);
  });

  it('attributes separator-only chunks to the following source segment', async () => {
    const item: Item = {
      ...makeItem(),
      id: 'Q9',
      labels: { en: { language: 'en', value: 'aaaa' } },
      aliases: { en: [{ language: 'en', value: '🔥' }] },
      descriptions: {},
      claims: {},
    };
    const plan = await projectItemForUnifiedSearchV1({
      source: sourceEvent('item', item.id, '3'),
      item,
      authorization: await envelope('item', item.id, '3', PUBLIC),
      statementAuthorizations: {},
      mixedScope: 'partition',
      maxChunkBytes: 4,
    });
    expect(plan.chunks.map(({ text }) => text)).toEqual(['aaaa', '\n', '🔥']);
    expect(plan.chunks.every(({ trace }) => trace.length > 0)).toBe(true);
    expect(plan.chunks[1]!.trace).toEqual([
      expect.objectContaining({ field: 'alias', chunkStart: 0, chunkEnd: 1 }),
    ]);
  });

  it('partitions mixed scopes, can reject them explicitly, and never widens a private Item', async () => {
    const item = makeItem();
    const source = sourceEvent('item', item.id, '3');
    const itemPrivate = await envelope('item', item.id, '3', PRIVATE);
    const allPublic = await statementEnvelopeMap(item, PUBLIC);
    const hostile = await projectItemForUnifiedSearchV1({
      source,
      item,
      authorization: itemPrivate,
      statementAuthorizations: allPublic,
      mixedScope: 'partition',
    });
    expect(hostile.documents).toHaveLength(3);
    expect(
      hostile.documents.every(
        ({ authorization }) =>
          JSON.stringify(authorization.visibility) === JSON.stringify(PRIVATE),
      ),
    ).toBe(true);

    const mixed = await statementEnvelopeMap(item, PUBLIC);
    mixed['Q1$S2'] = await envelope('statement', 'Q1$S2', '3', WORKSPACE);
    const partitioned = await projectItemForUnifiedSearchV1({
      source,
      item,
      authorization: await envelope('item', item.id, '3', PUBLIC),
      statementAuthorizations: mixed,
      mixedScope: 'partition',
    });
    expect(partitioned.documents).toHaveLength(3);
    expect(
      partitioned.documents.flatMap(({ segments }) =>
        segments.filter(({ field }) => field === 'statement'),
      ),
    ).toHaveLength(2);
    await expect(
      projectItemForUnifiedSearchV1({
        source,
        item,
        authorization: await envelope('item', item.id, '3', PUBLIC),
        statementAuthorizations: mixed,
        mixedScope: 'reject',
      }),
    ).rejects.toBeInstanceOf(MixedSearchProjectionScopeError);
  });

  it('recognizes Workshop-owned deferred kinds structurally but their pure projectors remain external', () => {
    const deferred: Array<() => never> = [
      projectTaskForUnifiedSearchV1,
      projectMemoryForUnifiedSearchV1,
      projectPromptForUnifiedSearchV1,
    ];
    for (const projector of deferred)
      expect(projector).toThrow(UnsupportedSearchProjectionError);
  });

  it('strictly normalizes source events and rejects noncanonical hashes', () => {
    expect(
      normalizeSearchProjectionSourceEventV1(
        sourceEvent('item', 'Q1', 'opaque:1'),
      ).sourceRevision,
    ).toBe('opaque:1');
    expect(() =>
      normalizeSearchProjectionSourceEventV1({
        ...sourceEvent('item', 'Q1', '1'),
        sourceHash: SOURCE_HASH.toUpperCase(),
      }),
    ).toThrow(InvalidSearchContractError);
  });
});

function sourceEvent(
  kind: UnifiedSearchKind,
  sourceId: string,
  sourceRevision: string,
) {
  return {
    version: 1 as const,
    eventId: `event-${sourceId.replaceAll('$', '-')}`,
    operation: 'upsert' as const,
    installationId: 'installation-1',
    kind,
    sourceId,
    sourceRevision,
    sourceHash: SOURCE_HASH,
    sourcePolicyRevision: 4,
    authorizationRevision: 4,
    searchGeneration: 9,
  };
}

function envelope(
  sourceKind: UnifiedSearchKind,
  sourceId: string,
  sourceRevision: string,
  visibility: VisibilityScopeV1,
) {
  return createTrustedSearchAuthorizationEnvelopeV1(PROJECTION_AUTHORITY, {
    version: 1,
    sourceKind,
    sourceId,
    sourceRevision,
    installationId: 'installation-1',
    workspaceId: 'workspace-1',
    ownerPrincipalId: 'owner-1',
    sourcePolicyRevision: 4,
    authorizationRevision: 4,
    visibility,
  });
}

function makeStatement(id: string, text: string, property = 'P2'): Statement {
  return {
    id,
    type: 'statement',
    text,
    rank: 'normal',
    mainsnak: {
      snaktype: 'value',
      property: property as `P${number}`,
      datatype: 'string',
      datavalue: { type: 'string', value: 'structured value is not projected' },
    },
    qualifiers: {},
    'qualifiers-order': [],
    references: [],
  };
}

function makeItem(): Item {
  const typeStatement = makeStatement('Q1$S1', 'type statement text', 'P31');
  typeStatement.mainsnak = {
    snaktype: 'value',
    property: 'P31',
    datatype: 'wikibase-item',
    datavalue: {
      type: 'wikibase-entityid',
      value: { 'entity-type': 'item', 'numeric-id': 5, id: 'Q5' },
    },
  };
  return {
    id: 'Q1',
    type: 'item',
    labels: { en: { language: 'en', value: 'Kiln' } },
    aliases: {
      en: [
        { language: 'en', value: 'Four' },
        { language: 'en', value: 'Oven' },
      ],
    },
    descriptions: {
      en: { language: 'en', value: 'A very hot kiln' },
    },
    claims: {
      P31: [typeStatement],
      P2: [makeStatement('Q1$S2', 'other statement text 🔥')],
    },
    sitelinks: {},
    lastrevid: 3,
    modified: '2026-07-22T00:00:00.000Z',
  };
}

function statements(item: Item): Statement[] {
  return (Object.keys(item.claims) as PropertyId[]).flatMap(
    (property) => item.claims[property] ?? [],
  );
}

async function statementEnvelopeMap(
  item: Item,
  visibility: VisibilityScopeV1,
): Promise<Record<string, TrustedSearchAuthorizationEnvelopeV1>> {
  return Object.fromEntries<TrustedSearchAuthorizationEnvelopeV1>(
    await Promise.all(
      statements(item).map(
        async (statement) =>
          [
            statement.id,
            await envelope(
              'statement',
              statement.id,
              `${item.lastrevid}`,
              visibility,
            ),
          ] as const,
      ),
    ),
  );
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
