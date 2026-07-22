import {
  RevisionConflictError,
  SEARCH_ADMIN_CAPABILITY,
  KNOWLEDGE_WRITE_CAPABILITY,
  KNOWLEDGE_POLICY_CAPABILITY,
  addStatement,
  bootstrapTaprootAuthorization,
  createAuthorizationCursorCodec,
  createAuthorizedTaproot,
  createItem,
  createProperty,
  createTaprootHostWriteCapability,
  createInstallationAuthorizationGuard,
  exportEntityJson,
  initializeTaproot,
  setLabel,
  setStatementRank,
  type CanonicalAuthorizationPolicyInput,
  type D1DatabaseLike,
  type Statement,
  type AuthorizationContext,
} from '@gnolith/taproot';
import { createSparqlHandler } from '@gnolith/diamond';

export async function runTaprootInteropDemo(db: D1DatabaseLike) {
  await initializeTaproot(db, { baseIri: 'https://knowledge.example' });
  const options = { baseIri: 'https://knowledge.example' };
  const writeCapability = createTaprootHostWriteCapability(
    db,
    options,
    await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]),
  );
  await bootstrapTaprootAuthorization(
    db,
    options,
    writeCapability,
    'demo-installation',
  );
  const authorizationGuard = await createInstallationAuthorizationGuard(
    db,
    options,
    writeCapability,
  );

  await createProperty(db, options, authorizationGuard, writer(1), {
    datatype: 'string',
    labels: { en: { language: 'en', value: 'occupation' } },
    authorization: policy(1),
  });
  await createProperty(db, options, authorizationGuard, writer(2), {
    datatype: 'time',
    labels: { en: { language: 'en', value: 'point in time' } },
    authorization: policy(2),
  });
  await createProperty(db, options, authorizationGuard, writer(3), {
    datatype: 'url',
    labels: { en: { language: 'en', value: 'reference URL' } },
    authorization: policy(3),
  });

  const created = await createItem(db, options, authorizationGuard, writer(4), {
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
    authorization: policy(4),
  });
  const occupation: Statement = {
    id: `${created.entityId}$occupation`,
    type: 'statement',
    text: 'Ada Lovelace worked as a computer programmer in 1843.',
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
  const added = await addStatement(
    db,
    options,
    authorizationGuard,
    writer(5, true),
    created.entityId,
    occupation,
    {
      expectedRevision: created.newRevision,
      authorization: policy(5, { [occupation.id]: [] }),
    },
  );
  const preferred = await setStatementRank(
    db,
    options,
    authorizationGuard,
    writer(6),
    created.entityId,
    occupation.id,
    'preferred',
    'Ada Lovelace worked as a computer programmer in 1843 (preferred).',
    {
      expectedRevision: added.newRevision,
      authorization: policy(6, { [occupation.id]: [] }),
    },
  );
  const unknownOccupation: Statement = {
    id: `${created.entityId}$unknown-occupation`,
    type: 'statement',
    text: 'Ada Lovelace had another occupation whose value is unknown.',
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
  await addStatement(
    db,
    options,
    authorizationGuard,
    writer(7, true),
    created.entityId,
    unknownOccupation,
    {
      expectedRevision: preferred.newRevision,
      authorization: policy(7, {
        [occupation.id]: [],
        [unknownOccupation.id]: [],
      }),
    },
  );

  const sparql = createSparqlHandler({ db });
  const query = `SELECT ?occupation WHERE {
    <https://knowledge.example/entity/${created.entityId}>
      <https://knowledge.example/prop/direct/P1> ?occupation
  }`;
  const response = await sparql(
    new Request(
      `https://interop.example/sparql?query=${encodeURIComponent(query)}`,
      { headers: { accept: 'application/sparql-results+json' } },
    ),
  );

  let staleRevisionRejected = false;
  try {
    await setLabel(
      db,
      options,
      authorizationGuard,
      writer(8),
      created.entityId,
      'en',
      'stale edit',
      {
        expectedRevision: created.newRevision,
        authorization: policy(8, {
          [occupation.id]: [],
          [unknownOccupation.id]: [],
        }),
      },
    );
  } catch (cause) {
    staleRevisionRejected = cause instanceof RevisionConflictError;
  }

  const sparqlResults: unknown = await response.json();
  const reader = createAuthorizedTaproot(
    db,
    options,
    {
      installationId: 'demo-installation',
      principalId: 'demo-principal',
      activeWorkspaceId: null,
      workspaceIds: [],
      capabilities: [SEARCH_ADMIN_CAPABILITY],
      authorizationRevision: 8,
    },
    {
      cursorCodec: createAuthorizationCursorCodec(
        await crypto.subtle.generateKey(
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt'],
        ),
      ),
    },
  );
  const audit = await reader.listAuditEvents({ entityId: created.entityId });
  const integrity = await reader.inspectEntityIntegrity(created.entityId);
  const canonical = await reader.getEntity(created.entityId);
  return {
    entityJson: exportEntityJson(canonical.entity),
    sparqlResults,
    staleRevisionRejected,
    audit: audit.items,
    integrity,
  };
}

function policy(
  expectedAuthorizationRevision: number,
  statementRestrictions: CanonicalAuthorizationPolicyInput['statementRestrictions'] = {},
): CanonicalAuthorizationPolicyInput {
  return {
    installationId: 'demo-installation',
    workspaceId: null,
    ownerPrincipalId: 'demo-principal',
    visibility: { version: 1, clauses: [] },
    statementRestrictions,
    expectedAuthorizationRevision,
  };
}

function writer(
  authorizationRevision: number,
  policyAuthority = false,
): AuthorizationContext {
  return {
    installationId: 'demo-installation',
    principalId: 'demo-principal',
    activeWorkspaceId: null,
    workspaceIds: [],
    capabilities: [
      KNOWLEDGE_WRITE_CAPABILITY,
      ...(policyAuthority ? [KNOWLEDGE_POLICY_CAPABILITY] : []),
    ],
    authorizationRevision,
  };
}
