import {
  RevisionConflictError,
  TaprootRepository,
  exportEntityJson,
  initializeTaproot,
  type D1DatabaseLike,
  type Statement,
} from '@gnolith/taproot';
import { createSparqlHandler } from '@gnolith/diamond';

export async function runTaprootDemo(db: D1DatabaseLike) {
  await initializeTaproot(db);
  const taproot = new TaprootRepository(db, {
    baseIri: 'https://knowledge.example',
  });

  await taproot.createProperty({
    datatype: 'string',
    labels: { en: { language: 'en', value: 'occupation' } },
  });
  await taproot.createProperty({
    datatype: 'time',
    labels: { en: { language: 'en', value: 'point in time' } },
  });
  await taproot.createProperty({
    datatype: 'url',
    labels: { en: { language: 'en', value: 'reference URL' } },
  });

  const created = await taproot.createItem({
    labels: { en: { language: 'en', value: 'Ada Lovelace' } },
    descriptions: {
      en: { language: 'en', value: 'English mathematician' },
    },
    attribution: {
      id: 'agent:demo-curator',
      kind: 'agent',
      tool: 'gnolith-mcp',
    },
    requestId: 'demo-request',
  });
  const occupation: Statement = {
    id: `${created.entityId}$occupation`,
    type: 'statement',
    rank: 'normal',
    mainsnak: {
      snaktype: 'value',
      property: 'P1',
      datatype: 'string',
      datavalue: { type: 'string', value: 'computer programmer' },
    },
    qualifiers: {
      P2: [
        {
          snaktype: 'value',
          property: 'P2',
          datatype: 'time',
          datavalue: {
            type: 'time',
            value: {
              time: '+1843-01-01T00:00:00Z',
              timezone: 0,
              before: 0,
              after: 0,
              precision: 9,
              calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
            },
          },
        },
      ],
    },
    'qualifiers-order': ['P2'],
    references: [
      {
        hash: 'demo-source',
        snaks: {
          P3: [
            {
              snaktype: 'value',
              property: 'P3',
              datatype: 'url',
              datavalue: {
                type: 'string',
                value: 'https://example.test/source',
              },
            },
          ],
        },
        'snaks-order': ['P3'],
      },
    ],
  };
  const added = await taproot.addStatement(created.entityId, occupation, {
    expectedRevision: created.newRevision,
  });
  const preferred = await taproot.setStatementRank(
    created.entityId,
    occupation.id,
    'preferred',
    { expectedRevision: added.newRevision },
  );
  const unknownOccupation: Statement = {
    id: `${created.entityId}$unknown-occupation`,
    type: 'statement',
    rank: 'normal',
    mainsnak: {
      snaktype: 'somevalue',
      property: 'P1',
      datatype: 'string',
    },
    qualifiers: {},
    'qualifiers-order': [],
    references: [],
  };
  const special = await taproot.addStatement(
    created.entityId,
    unknownOccupation,
    { expectedRevision: preferred.newRevision },
  );

  const sparql = createSparqlHandler({ db });
  const query = `SELECT ?occupation WHERE {
    <https://knowledge.example/entity/${created.entityId}>
      <https://knowledge.example/prop/direct/P1> ?occupation
  }`;
  const response = await sparql(
    new Request(
      `https://site.example/api/sparql?query=${encodeURIComponent(query)}`,
      { headers: { accept: 'application/sparql-results+json' } },
    ),
  );

  let staleRevisionRejected = false;
  try {
    await taproot.setLabel(created.entityId, 'en', 'stale edit', {
      expectedRevision: created.newRevision,
    });
  } catch (cause) {
    staleRevisionRejected = cause instanceof RevisionConflictError;
  }

  const sparqlResults: unknown = await response.json();
  const audit = await taproot.listAuditEvents({ entityId: created.entityId });
  const integrity = await taproot.inspectEntityIntegrity(created.entityId);
  return {
    entityJson: exportEntityJson(special.entity),
    sparqlResults,
    staleRevisionRejected,
    audit: audit.items,
    integrity,
  };
}
