import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { webcrypto } from 'node:crypto';
import { join } from 'node:path';
import * as taproot from '@gnolith/taproot';
import * as search from '@gnolith/taproot/search';

const options = { baseIri: 'https://packed-label-noop.example' };
const installationId = 'packed-label-noop-installation';
const databasePath = join(process.cwd(), 'packed-label-noop.sqlite');
let db = new NodeSqliteDatabase(databasePath);

try {
  await taproot.initializeTaproot(db, options);
  let authority = await hostAuthority(db);
  const owner = await taproot.registerAuthorizationBootstrapOwnerV1(
    db,
    options,
    authority,
    {
      installationId,
      ownerRegistrationId: 'packed-label-owner',
      adapter: {
        kind: 'taproot-authorization-bootstrap-owner-adapter-v1',
        prepare: () => Promise.resolve({ statements: [], receipt: {} }),
      },
    },
  );
  const bootstrap = await taproot.prepareAuthorizationBootstrapV1(
    db,
    options,
    authority,
    {
      installationId,
      baseIri: options.baseIri,
      principalId: 'principal-1',
      workspaceId: 'workspace-1',
      grants: [
        taproot.KNOWLEDGE_POLICY_CAPABILITY,
        'knowledge:read',
        taproot.KNOWLEDGE_WRITE_CAPABILITY,
        'search:admin',
      ],
      idempotencyKey: 'packed-label-bootstrap',
    },
  );
  await taproot.commitAuthorizationBootstrapV1(
    bootstrap,
    await owner.seal(bootstrap, {}),
  );

  let port = await taproot.createTaprootWorkshopPortV1(db, options, authority, {
    installationId,
  });
  let context = await resolve(port);
  await port.createItem(
    {
      id: 'Q1',
      labels: { en: { language: 'en', value: 'Original item' } },
    },
    { idempotencyKey: 'packed-create-item' },
    context,
  );
  context = await resolve(port);
  await port.createProperty(
    {
      id: 'P1',
      datatype: 'string',
      labels: { en: { language: 'en', value: 'Stable property' } },
    },
    { idempotencyKey: 'packed-create-property' },
    context,
  );
  context = await resolve(port);
  let guard = await taproot.createInstallationAuthorizationGuard(
    db,
    options,
    authority,
  );
  const changed = await taproot.setLabel(
    db,
    options,
    guard,
    context,
    'Q1',
    'en',
    'Stable item',
    {
      expectedRevision: 1,
      authorization: policy(context.authorizationRevision),
    },
  );
  if (
    changed.previousRevision !== 1 ||
    changed.newRevision !== 2 ||
    changed.changed !== true
  )
    throw new Error('packed changed label did not revise exactly once');

  context = await resolve(port);
  const before = await canonicalState(db);
  const itemEdit = {
    expectedRevision: 2,
    authorization: policy(context.authorizationRevision),
  };
  const [first, concurrent] = await Promise.all([
    taproot.setLabel(
      db,
      options,
      guard,
      context,
      'Q1',
      'en',
      'Stable item',
      itemEdit,
    ),
    taproot.setLabel(
      db,
      options,
      guard,
      context,
      'Q1',
      'en',
      'Stable item',
      itemEdit,
    ),
  ]);
  if (
    JSON.stringify(first) !== JSON.stringify(concurrent) ||
    first.previousRevision !== 2 ||
    first.newRevision !== 2 ||
    first.changed !== false
  )
    throw new Error('packed public identical Item label receipt was unstable');
  const expectedPublicReceiptBytes = JSON.stringify({
    entityId: 'Q1',
    previousRevision: 2,
    newRevision: 2,
    changed: false,
    status: 'committed',
    authorizationRevision: context.authorizationRevision,
    searchGeneration: context.authorizationRevision,
  });
  if (JSON.stringify(first) !== expectedPublicReceiptBytes)
    throw new Error(
      `packed public no-op receipt bytes changed: ${JSON.stringify(first)}`,
    );
  const property = await taproot.setLabel(
    db,
    options,
    guard,
    context,
    'P1',
    'en',
    'Stable property',
    {
      expectedRevision: 1,
      authorization: policy(context.authorizationRevision),
    },
  );
  if (
    property.previousRevision !== 1 ||
    property.newRevision !== 1 ||
    property.changed !== false
  )
    throw new Error('packed public identical Property label revised');
  const identicalRequest = [
    {
      command: {
        type: 'set-label',
        language: 'en',
        value: 'Stable item',
      },
      authoredText: 'Retry the stable packed Item label.',
    },
  ];
  const [adapterReceipt, adapterConcurrent] = await Promise.all([
    port.mutateEntity(
      'Q1',
      identicalRequest,
      { expectedRevision: 2, idempotencyKey: 'packed-identical-label' },
      context,
    ),
    port.mutateEntity(
      'Q1',
      identicalRequest,
      { expectedRevision: 2, idempotencyKey: 'packed-identical-label' },
      context,
    ),
  ]);
  if (
    JSON.stringify(adapterReceipt) !== JSON.stringify(adapterConcurrent) ||
    adapterReceipt.changed !== false
  )
    throw new Error('packed Workshop concurrent retry receipt was unstable');
  assertState(before, await canonicalState(db), 'before restart');

  await db.close();
  db = new NodeSqliteDatabase(databasePath);
  authority = await hostAuthority(db);
  port = await taproot.createTaprootWorkshopPortV1(db, options, authority, {
    installationId,
  });
  context = await resolve(port);
  guard = await taproot.createInstallationAuthorizationGuard(
    db,
    options,
    authority,
  );
  const restarted = await taproot.setLabel(
    db,
    options,
    guard,
    context,
    'Q1',
    'en',
    'Stable item',
    {
      expectedRevision: 2,
      authorization: policy(context.authorizationRevision),
    },
  );
  if (JSON.stringify(restarted) !== JSON.stringify(first))
    throw new Error('packed public restart receipt was unstable');
  const adapterRestarted = await port.mutateEntity(
    'Q1',
    identicalRequest,
    { expectedRevision: 2, idempotencyKey: 'packed-identical-label' },
    context,
  );
  if (JSON.stringify(adapterRestarted) !== JSON.stringify(adapterReceipt))
    throw new Error('packed Workshop restart receipt was unstable');
  assertState(before, await canonicalState(db), 'after restart');

  await port.mutateEntity(
    'Q1',
    [
      {
        command: {
          type: 'set-label',
          language: 'en',
          value: 'Visibility target revision three',
        },
        authoredText: 'Advance Q1 to the exact visibility target revision.',
      },
    ],
    { expectedRevision: 2, idempotencyKey: 'packed-q1-revision-3' },
    context,
  );
  context = await resolve(port);
  const administrationOwner =
    await taproot.registerAuthorizationAdministrationOwnerV1(
      db,
      options,
      authority,
      {
        installationId,
        ownerRegistrationId: 'packed-visibility-owner',
        adapter: {
          kind: 'taproot-authorization-administration-owner-adapter-v1',
          prepare: () => Promise.resolve({ statements: [], receipt: {} }),
        },
      },
    );
  const commitAdministration = async (command, idempotencyKey) => {
    context = await resolve(port);
    const input = {
      installationId,
      expectedAuthorizationRevision: context.authorizationRevision,
      idempotencyKey,
      command,
    };
    const participant = await taproot.prepareAuthorizationAdministrationV1(
      db,
      options,
      authority,
      input,
      context,
    );
    return {
      input,
      receipt: await taproot.commitAuthorizationAdministrationV1(
        participant,
        await administrationOwner.seal(participant, {}),
      ),
    };
  };
  await commitAdministration(
    { type: 'put-principal', principalId: 'principal-reader' },
    'packed-register-reader',
  );
  await commitAdministration(
    { type: 'put-principal', principalId: 'principal-outsider' },
    'packed-register-outsider',
  );
  await commitAdministration(
    {
      type: 'put-grant',
      principalId: 'principal-reader',
      workspaceId: 'workspace-1',
      capability: 'knowledge:read',
      granted: true,
    },
    'packed-grant-reader',
  );
  context = await resolve(port);
  await port.createItem(
    {
      id: 'Q2',
      labels: { en: { language: 'en', value: 'Clean visibility item' } },
    },
    { idempotencyKey: 'packed-create-q2-clean' },
    context,
  );
  const ownerOrReader = {
    version: 1,
    // CNF clauses are ANDed; owner and reader alternatives share one OR-clause.
    clauses: [
      [
        { kind: 'principal', principalId: 'principal-1' },
        { kind: 'principal', principalId: 'principal-reader' },
      ],
    ],
  };
  const q2Visibility = await commitAdministration(
    {
      type: 'set-entity-visibility',
      entityId: 'Q2',
      expectedRevision: 1,
      visibility: ownerOrReader,
    },
    'packed-visibility-policy-set-q2-1',
  );
  const q2After = await entityVisibilityState(db, 'Q2');
  if (
    q2Visibility.receipt.replayed ||
    q2After.entityRevision !== 2 ||
    q2After.sourceRevision !== 2 ||
    q2After.visibilityJson !== JSON.stringify(ownerOrReader)
  )
    throw new Error('packed clean Q2 revision 1 visibility did not commit');
  context = await resolve(port);
  const q2Replay = await taproot.prepareAuthorizationAdministrationV1(
    db,
    options,
    authority,
    q2Visibility.input,
    context,
  );
  const q2ReplayReceipt = await taproot.commitAuthorizationAdministrationV1(
    q2Replay,
    await administrationOwner.seal(q2Replay, {}),
  );
  if (
    !q2ReplayReceipt.replayed ||
    JSON.stringify(await entityVisibilityState(db, 'Q2')) !==
      JSON.stringify(q2After)
  )
    throw new Error('packed clean Q2 visibility replay was not a no-op');

  context = await resolve(port);
  const visibilityInput = {
    installationId,
    expectedAuthorizationRevision: context.authorizationRevision,
    idempotencyKey: 'packed-visibility-policy-set-q1-3',
    command: {
      type: 'set-entity-visibility',
      entityId: 'Q1',
      expectedRevision: 3,
      visibility: ownerOrReader,
    },
  };
  const visibility = await taproot.prepareAuthorizationAdministrationV1(
    db,
    options,
    authority,
    visibilityInput,
    context,
  );
  const visibilityReceipt = await taproot.commitAuthorizationAdministrationV1(
    visibility,
    await administrationOwner.seal(visibility, {}),
  );
  if (
    visibilityReceipt.command !== 'set-entity-visibility' ||
    Number(
      (
        await db
          .prepare(`SELECT revision FROM taproot_entities WHERE entity_id='Q1'`)
          .all()
      ).results[0]?.revision,
    ) !== 4
  )
    throw new Error('packed Q1 revision 3 visibility policy did not commit');
  const ownerAndReader = {
    version: 1,
    clauses: [
      [{ kind: 'principal', principalId: 'principal-1' }],
      [{ kind: 'principal', principalId: 'principal-reader' }],
    ],
  };
  context = await resolve(port);
  const beforeUnsatisfiable = await entityVisibilityState(db, 'Q1');
  const unsatisfiable = await taproot.prepareAuthorizationAdministrationV1(
    db,
    options,
    authority,
    {
      installationId,
      expectedAuthorizationRevision: context.authorizationRevision,
      idempotencyKey: 'packed-visibility-policy-unsatisfiable-cnf',
      command: {
        type: 'set-entity-visibility',
        entityId: 'Q1',
        expectedRevision: 4,
        visibility: ownerAndReader,
      },
    },
    context,
  );
  const unsatisfiableError = await taproot
    .commitAuthorizationAdministrationV1(
      unsatisfiable,
      await administrationOwner.seal(unsatisfiable, {}),
    )
    .catch((error) => error);
  if (
    unsatisfiableError?.code !== 'INVALID_ENTITY' ||
    JSON.stringify(await entityVisibilityState(db, 'Q1')) !==
      JSON.stringify(beforeUnsatisfiable)
  )
    throw new Error('packed owner-AND-reader CNF was not rejected atomically');

  context = await resolve(port);
  const stale = await taproot.prepareAuthorizationAdministrationV1(
    db,
    options,
    authority,
    {
      ...visibilityInput,
      expectedAuthorizationRevision: context.authorizationRevision,
      idempotencyKey: 'packed-visibility-policy-stale',
    },
    context,
  );
  const staleError = await taproot
    .commitAuthorizationAdministrationV1(
      stale,
      await administrationOwner.seal(stale, {}),
    )
    .catch((error) => error);
  if (staleError?.code !== 'REVISION_CONFLICT')
    throw new Error('packed stale visibility target did not conflict');

  const readerContext = await port.resolveAuthorization({
    principalId: 'principal-reader',
    activeWorkspaceId: 'workspace-1',
  });
  const outsiderContext = await port.resolveAuthorization({
    principalId: 'principal-outsider',
  });
  const cursorKey = await webcrypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const cursorCodec = taproot.createAuthorizationCursorCodec(cursorKey);
  for (const visibleContext of [context, readerContext]) {
    const reader = taproot.createAuthorizedTaproot(
      db,
      options,
      visibleContext,
      { cursorCodec },
    );
    await reader.getEntity('Q1');
    await reader.getEntity('Q2');
  }
  const outsider = taproot.createAuthorizedTaproot(
    db,
    options,
    outsiderContext,
    { cursorCodec },
  );
  for (const entityId of ['Q1', 'Q2']) {
    const denied = await outsider.getEntity(entityId).catch((error) => error);
    if (denied?.code !== 'AUTHORIZATION_DENIED')
      throw new Error(`packed outsider read ${entityId}`);
  }

  const materialization = await search.createSearchMaterializationAdminGuardV1(
    db,
    options,
    authority,
  );
  await materialization.initialize(context);
  await materialization.run(context, {
    maxJobs: 100,
    maxRebuildRoots: 100,
  });
  const embeddingEndpoint = 'http://127.0.0.1:9/v1/embeddings';
  const semanticFetch = (input, init) => {
    const url =
      input instanceof globalThis.Request
        ? input.url
        : input instanceof globalThis.URL
          ? input.href
          : input;
    if (url !== embeddingEndpoint)
      throw new Error(`unexpected packed semantic URL: ${url}`);
    const body = JSON.parse(String(init?.body));
    return Promise.resolve(
      new globalThis.Response(
        JSON.stringify({
          data: body.input.map(() => ({ embedding: [1, 0] })),
          usage: { total_tokens: body.input.length },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  };
  const createSemantic = () =>
    search.createSemanticSearchAdminV1(db, {
      installationId,
      fetch: semanticFetch,
    });
  const semantic = createSemantic();
  await semantic.configure(
    {
      version: 1,
      id: 'packed-protected-sqlite',
      name: 'packed-protected-sqlite',
      provider: {
        kind: 'openai-compatible',
        endpoint: embeddingEndpoint,
        model: 'deterministic',
        dimensions: 2,
        metric: 'cosine',
        credentialSelector: null,
        allowPrivateEndpoint: true,
        redirectPolicy: 'error',
      },
      vector: { kind: 'sqlite' },
    },
    {
      expectedRevision: 0,
      idempotencyKey: 'packed-protected-sqlite-v1',
    },
    context,
  );
  const { planId } = await semantic.estimate(
    'packed-protected-sqlite',
    { mode: 'asap' },
    context,
  );
  await semantic.approve(planId, context);
  await semantic.run(planId, context);
  await semantic.select('packed-protected-sqlite', context);
  const semanticStatus = await semantic.status(context);
  if (
    !semanticStatus.ready ||
    semanticStatus.state !== 'ready' ||
    semanticStatus.failureCode !== null
  )
    throw new Error('packed protected SQLite semantic state was not ready');
  const semanticQuery = {
    text: 'visibility target',
    kinds: ['item'],
    limit: 10,
    context: { ...context, capabilities: [] },
  };
  if ((await semantic.search(semanticQuery)).length !== 2)
    throw new Error(
      'packed protected SQLite semantic search did not return Q1 and Q2',
    );
  if (
    (
      await semantic.search({
        ...semanticQuery,
        context: { ...readerContext, capabilities: [] },
      })
    ).length !== 2 ||
    (
      await semantic.search({
        ...semanticQuery,
        context: outsiderContext,
      })
    ).length !== 0
  )
    throw new Error('packed protected SQLite semantic principal filter failed');

  await db.close();
  db = new NodeSqliteDatabase(databasePath);
  const restartedSemantic = createSemantic();
  if (
    (await restartedSemantic.search(semanticQuery)).length !== 2 ||
    (
      await restartedSemantic.search({
        ...semanticQuery,
        context: { ...readerContext, capabilities: [] },
      })
    ).length !== 2 ||
    (
      await restartedSemantic.search({
        ...semanticQuery,
        context: outsiderContext,
      })
    ).length !== 0
  )
    throw new Error(
      'packed protected SQLite principal filtering did not survive restart',
    );
} finally {
  await db.close();
}

async function hostAuthority(database) {
  const key = await webcrypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return taproot.createTaprootHostWriteCapability(database, options, key);
}

function resolve(port) {
  return port.resolveAuthorization({
    principalId: 'principal-1',
    activeWorkspaceId: 'workspace-1',
  });
}

function policy(expectedAuthorizationRevision) {
  return {
    installationId,
    workspaceId: 'workspace-1',
    ownerPrincipalId: 'principal-1',
    visibility: {
      version: 1,
      clauses: [[{ kind: 'workspace', workspaceId: 'workspace-1' }]],
    },
    statementRestrictions: {},
    expectedAuthorizationRevision,
  };
}

async function canonicalState(database) {
  const result = await database
    .prepare(
      `SELECT
         (SELECT revision FROM taproot_entities WHERE entity_id='Q1') AS item_revision,
         (SELECT revision FROM taproot_entities WHERE entity_id='P1') AS property_revision,
         (SELECT COUNT(*) FROM taproot_entity_revisions) AS revisions,
         (SELECT COUNT(*) FROM taproot_audit_events) AS audits,
         (SELECT COUNT(*) FROM taproot_rdf_ownership) AS ownership,
         (SELECT COUNT(*) FROM rdf_quads) AS quads,
         (SELECT COUNT(*) FROM taproot_unified_search_source_events) AS source_events,
         (SELECT authorization_revision FROM taproot_installation_authorization
          WHERE singleton=1) AS authorization_revision,
         (SELECT search_generation FROM taproot_installation_authorization
          WHERE singleton=1) AS search_generation,
         (SELECT COALESCE(MAX(source_watermark_sequence), 0)
          FROM taproot_search_corpora) AS source_watermark,
         (SELECT COALESCE(MAX(enqueued_sequence), 0)
          FROM taproot_search_kind_checkpoints) AS enqueued_watermark,
         (SELECT COALESCE(MAX(applied_sequence), 0)
          FROM taproot_search_kind_checkpoints) AS applied_watermark`,
    )
    .all();
  return result.results[0];
}

async function entityVisibilityState(database, entityId) {
  const result = await database
    .prepare(
      `SELECT e.revision AS entityRevision,
              p.source_revision AS sourceRevision,
              p.visibility_json AS visibilityJson,
              s.authorization_revision AS authorizationRevision,
              s.search_generation AS searchGeneration,
              (SELECT COUNT(*) FROM taproot_audit_events
               WHERE entity_id=e.entity_id) AS auditCount
       FROM taproot_entities e
       JOIN taproot_entity_authorization p ON p.entity_id=e.entity_id
       JOIN taproot_installation_authorization s ON s.singleton=1
       WHERE e.entity_id=?`,
    )
    .bind(entityId)
    .all();
  const row = result.results[0];
  if (!row) throw new Error(`missing packed visibility state for ${entityId}`);
  return {
    entityRevision: Number(row.entityRevision),
    sourceRevision: Number(row.sourceRevision),
    visibilityJson: String(row.visibilityJson),
    authorizationRevision: Number(row.authorizationRevision),
    searchGeneration: Number(row.searchGeneration),
    auditCount: Number(row.auditCount),
  };
}

function assertState(expected, actual, phase) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `packed identical labels changed canonical state ${phase}: ` +
        JSON.stringify({ expected, actual }),
    );
}
