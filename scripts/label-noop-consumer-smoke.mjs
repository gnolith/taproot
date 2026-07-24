import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { webcrypto } from 'node:crypto';
import { join } from 'node:path';
import * as taproot from '@gnolith/taproot';

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

function assertState(expected, actual, phase) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `packed identical labels changed canonical state ${phase}: ` +
        JSON.stringify({ expected, actual }),
    );
}
