import { describe, expect, it } from 'vitest';
import {
  createSearchProjectionAuthorizationAuthorityV1,
  createTrustedSearchAuthorizationEnvelopeV1,
  normalizeUnifiedSearchRequestV1,
  projectItemForUnifiedSearchV1,
  UNIFIED_SEARCH_KINDS,
  type SearchProjectionSourceEventV1,
} from '../src/search.js';
import type { Item, Property, VisibilityScopeV1 } from '../src/index.js';
import {
  PersistedEntityAuthorizationSource,
  type SqliteDatabaseLike,
} from '../src/index.js';

const PUBLIC: VisibilityScopeV1 = { version: 1, clauses: [] };
const source = (
  sourceId: string,
  sourceRevision = '1',
): SearchProjectionSourceEventV1 => ({
  version: 1,
  eventId: `event-${sourceId}`,
  operation: 'upsert',
  installationId: 'installation',
  kind: 'item',
  sourceId,
  sourceRevision,
  sourceHash: 'a'.repeat(64),
  sourcePolicyRevision: 1,
  authorizationRevision: 1,
  searchGeneration: 1,
});

describe('architecture-reset search contract', () => {
  it('enumerates exactly the four built-in kinds and rejects unknown strings', () => {
    expect(UNIFIED_SEARCH_KINDS).toEqual([
      'item',
      'statement',
      'resource',
      'annotation',
    ]);
    expect(() =>
      normalizeUnifiedSearchRequestV1({
        version: 1,
        text: 'needle',
        kinds: ['not-registered'],
        filters: {},
        limit: 10,
        cursor: null,
      }),
    ).toThrow(/kind/u);
  });

  it.each([['item', item()] as const, ['property', property()] as const])(
    'projects a canonical %s through item kind with exact entity type',
    async (entityType, entity) => {
      const authority = createSearchProjectionAuthorizationAuthorityV1(
        new PersistedEntityAuthorizationSource({} as SqliteDatabaseLike),
      );
      const authorization = await createTrustedSearchAuthorizationEnvelopeV1(
        authority,
        {
          version: 1,
          sourceKind: 'item',
          sourceId: entity.id,
          sourceRevision: '1',
          installationId: 'installation',
          workspaceId: null,
          ownerPrincipalId: 'owner',
          sourcePolicyRevision: 1,
          authorizationRevision: 1,
          visibility: PUBLIC,
        },
      );
      const statementAuthorizations = Object.fromEntries(
        Object.values(entity.claims)
          .flat()
          .map((statement) => [statement.id, authorization]),
      );
      const plan = await projectItemForUnifiedSearchV1({
        source: source(entity.id),
        item: entity,
        authorization,
        statementAuthorizations,
        mixedScope: 'partition',
      });
      const itemDocument = plan.documents.find(
        (document) => document.kind === 'item',
      );
      expect(itemDocument?.filterMetadata.byKind.item?.entityTypes).toEqual([
        entityType,
      ]);
    },
  );
});

function item(): Item {
  return {
    id: 'Q1',
    type: 'item',
    labels: { en: { language: 'en', value: 'Fixture item' } },
    descriptions: {},
    aliases: {},
    claims: {},
    sitelinks: {},
    lastrevid: 1,
    modified: '2026-07-23T00:00:00.000Z',
  };
}

function property(): Property {
  return {
    id: 'P1',
    type: 'property',
    datatype: 'string',
    labels: { en: { language: 'en', value: 'Fixture property' } },
    descriptions: {},
    aliases: {},
    claims: {},
    lastrevid: 1,
    modified: '2026-07-23T00:00:00.000Z',
  };
}
