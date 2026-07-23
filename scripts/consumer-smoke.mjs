import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('consumer smoke must be run through npm');

const root = mkdtempSync(join(tmpdir(), 'taproot-consumer-'));
const sourcePackage = JSON.parse(readFileSync('package.json', 'utf8'));
const packagePath = join(...sourcePackage.name.split('/'));
const packOutput = execFileSync(
  process.execPath,
  [npmCli, 'pack', '--json', '--pack-destination', root],
  { encoding: 'utf8' },
);
const [{ filename, integrity, shasum }] = JSON.parse(packOutput);
const archive = join(root, filename);
const taprootSha256 = createHash('sha256')
  .update(readFileSync(archive))
  .digest('hex');
console.log(
  `Taproot packed artifact sha256=${taprootSha256} integrity=${integrity} shasum=${shasum}`,
);

writeFileSync(
  join(root, 'package.json'),
  JSON.stringify({ private: true, type: 'module' }),
);
execFileSync(
  process.execPath,
  [
    npmCli,
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefix',
    root,
    archive,
    'miniflare@^4.20260714.0',
  ],
  { stdio: 'inherit' },
);
const dependencyTree = JSON.parse(
  execFileSync(
    process.execPath,
    [npmCli, 'ls', '@gnolith/diamond', '--all', '--json', '--prefix', root],
    { encoding: 'utf8' },
  ),
);
const diamondInstances = collectDependencyVersions(
  dependencyTree,
  '@gnolith/diamond',
);
if (diamondInstances.length !== 1 || diamondInstances[0] !== '0.4.1') {
  throw new Error(
    `consumer must install one Diamond 0.4.1 runtime; found ${JSON.stringify(diamondInstances)}`,
  );
}
writeFileSync(
  join(root, 'smoke.mjs'),
  `
    import { createSparqlHandler } from '@gnolith/diamond';
    import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
    import * as taprootApi from '@gnolith/taproot';
    import {
      addStatement,
      bootstrapTaprootAuthorization,
      canonicalSearchBytesV1,
      createAuthorizedSearchServiceV1,
      createItem,
      createProperty,
      createInstallationAuthorizationGuard,
      createInstallationDomainMutationGuard,
      createInstallationSearchSourceGuardV1,
      createSearchMaterializationAdminGuardV1,
      createTaprootHostWriteCapability,
      createSearchProjectionAuthorizationAuthorityV1,
      createTrustedSearchAuthorizationEnvelopeV1,
      initializeTaproot,
      inspectTaprootSchema,
      KNOWLEDGE_POLICY_CAPABILITY,
      KNOWLEDGE_WRITE_CAPABILITY,
      PersistedEntityAuthorizationSource,
      projectItemForUnifiedSearchV1,
      projectStatementForUnifiedSearchV1,
      SEARCH_ADMIN_CAPABILITY,
    } from '@gnolith/taproot';
    import { Miniflare } from 'miniflare';

    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-07-19',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: crypto.randomUUID() },
    });
    const installationId = 'packed-consumer-installation';
    const writer = (authorizationRevision, policyAuthority = false) => ({
      installationId,
      principalId: 'packed-consumer-principal',
      activeWorkspaceId: null,
      workspaceIds: [],
      capabilities: [
        KNOWLEDGE_WRITE_CAPABILITY,
        ...(policyAuthority ? [KNOWLEDGE_POLICY_CAPABILITY] : []),
      ],
      authorizationRevision,
    });
    const policy = (expectedAuthorizationRevision, statementRestrictions = {}) => ({
      installationId,
      workspaceId: null,
      ownerPrincipalId: 'packed-consumer-principal',
      visibility: { version: 1, clauses: [] },
      statementRestrictions,
      expectedAuthorizationRevision,
    });
    const searchAdmin = (authorizationRevision) => ({
      installationId,
      principalId: 'packed-search-admin',
      activeWorkspaceId: null,
      workspaceIds: [],
      capabilities: [SEARCH_ADMIN_CAPABILITY],
      authorizationRevision,
    });
    let d1Guard;
    try {
      const db = await miniflare.getD1Database('DB');
      const options = { baseIri: 'https://knowledge.example' };
      await initializeTaproot(db, options);
      const d1WriteCapability = createTaprootHostWriteCapability(
        db,
        options,
        await crypto.subtle.generateKey(
          { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
        ),
      );
      await bootstrapTaprootAuthorization(
        db, options, d1WriteCapability, installationId,
      );
      d1Guard = await createInstallationAuthorizationGuard(
        db, options, d1WriteCapability,
      );
      await createProperty(db, options, d1Guard, writer(1), {
        id: 'P1', datatype: 'string', authorization: policy(1),
      });
      const item = await createItem(db, options, d1Guard, writer(2), {
        id: 'Q1',
        labels: { en: { language: 'en', value: 'clean consumer' } },
        authorization: policy(2),
      });
      if ('entity' in item || 'quadPatch' in item || item.status !== 'committed') {
        throw new Error('public write receipt disclosed canonical state');
      }
      await addStatement(
        db,
        options,
        d1Guard,
        writer(3, true),
        'Q1',
        {
          id: 'Q1$consumer',
          type: 'statement',
          text: 'The packed Taproot consumer works.',
          rank: 'normal',
          mainsnak: {
            snaktype: 'value',
            property: 'P1',
            datatype: 'string',
            datavalue: { type: 'string', value: 'works' },
          },
          qualifiers: {},
          'qualifiers-order': [],
          references: [],
        },
        {
          expectedRevision: item.newRevision,
          authorization: policy(3, { 'Q1$consumer': [] }),
        },
      );
      const d1Materialization = await createSearchMaterializationAdminGuardV1(
        db, options, d1WriteCapability,
      );
      await d1Materialization.initialize(searchAdmin(4));
      const d1MaterializationReceipt = await d1Materialization.run(
        searchAdmin(4),
        {
          maxJobs: 10,
          maxRebuildRoots: 10,
          maxChunkBytes: 64,
          leaseMilliseconds: 30_000,
        },
      );
      if (d1MaterializationReceipt.completed !== 1) {
        throw new Error('packed D1 materialization did not publish the Item root');
      }
      const packedSearch = createAuthorizedSearchServiceV1(db, {
        installationId,
      });
      const packedStatementTerm = await packedSearch.search(
        { text: 'The packed Taproot consumer works' },
        writer(4),
      );
      const packedKinds = new Set(
        packedStatementTerm.results.map(({ kind }) => kind),
      );
      if (!packedKinds.has('item') || !packedKinds.has('statement')) {
        throw new Error(
          'packed D1 statement-only term did not return Item and Statement results',
        );
      }
      const query = 'ASK { <https://knowledge.example/entity/Q1> <https://knowledge.example/prop/direct/P1> "works" }';
      const response = await createSparqlHandler({ db })(
        new Request('https://consumer.example/sparql?query=' + encodeURIComponent(query), {
          headers: { accept: 'application/sparql-results+json' },
        }),
      );
      const result = await response.json();
      if (!response.ok || result.boolean !== true) {
        throw new Error('Diamond could not query Taproot RDF in the packed consumer');
      }
      const schema = await inspectTaprootSchema(db);
      if (!schema.valid) throw new Error('fresh D1 schema inspection failed');
    } finally {
      await miniflare.dispose();
    }

    const local = new NodeSqliteDatabase(':memory:');
    try {
      const options = { baseIri: 'https://local.example' };
      await initializeTaproot(local, options);
      const localWriteCapability = createTaprootHostWriteCapability(
        local,
        options,
        await crypto.subtle.generateKey(
          { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
        ),
      );
      await bootstrapTaprootAuthorization(
        local, options, localWriteCapability, installationId,
      );
      const localGuard = await createInstallationAuthorizationGuard(
        local, options, localWriteCapability,
      );
      const taskGuard = await createInstallationDomainMutationGuard(
        local,
        options,
        localWriteCapability,
        { domain: 'workshop.task', capability: 'task-write' },
      );
      await local.prepare(
        'CREATE TABLE packed_task_probe(id TEXT PRIMARY KEY) STRICT',
      ).run();
      const taskContext = {
        installationId,
        principalId: 'packed-task-agent',
        activeWorkspaceId: null,
        workspaceIds: [],
        capabilities: ['task-write'],
        authorizationRevision: 1,
      };
      const taskCommit = await taskGuard.batchWithExpectedRevision(
        taskContext,
        [local.prepare("INSERT INTO packed_task_probe(id) VALUES ('task-ok') RETURNING id")],
      );
      if (
        taskCommit.authorizationRevision !== 1 ||
        taskCommit.searchGeneration !== 1 ||
        taskCommit.results[0]?.results[0]?.id !== 'task-ok'
      ) throw new Error('packed domain guard did not preserve ordered results');
      let crossCapabilityRejected = false;
      try {
        await taskGuard.batchWithExpectedRevision(writer(1), [
          local.prepare("INSERT INTO packed_task_probe(id) VALUES ('knowledge-denied')"),
        ]);
      } catch {
        crossCapabilityRejected = true;
      }
      if (!crossCapabilityRejected) {
        throw new Error('packed domain guard accepted a cross-domain capability');
      }
      let forgedSourceAuthorityRejected = false;
      try {
        await createInstallationSearchSourceGuardV1(
          local,
          options,
          { kind: 'taproot-host-write-v1' },
          {
            domain: 'workshop.task',
            sourceKind: 'task',
            capability: 'task-write',
            changeClasses: ['canonical'],
          },
        );
      } catch {
        forgedSourceAuthorityRejected = true;
      }
      if (!forgedSourceAuthorityRejected) {
        throw new Error('packed source guard accepted caller-shaped host authority');
      }
      const taskSourceGuard = await createInstallationSearchSourceGuardV1(
        local,
        options,
        localWriteCapability,
        {
          domain: 'workshop.task',
          sourceKind: 'task',
          capability: 'task-write',
          changeClasses: ['canonical'],
        },
      );
      const sourceCommit = await taskSourceGuard.batchWithSourceEvent(
        taskContext,
        {
          eventId: 'packed-task-source-1',
          sourceId: 'task-1',
          operation: 'upsert',
          changeClass: 'canonical',
          sourceRevision: 'opaque-r1',
          sourceHash: 'a'.repeat(64),
          predecessor: null,
        },
        [local.prepare("INSERT INTO packed_task_probe(id) VALUES ('task-source-ok')")],
      );
      if (
        sourceCommit.replayed ||
        sourceCommit.authorizationRevision !== 1 ||
        sourceCommit.searchGeneration !== 2
      ) throw new Error('packed source guard did not atomically advance one generation');
      const fencedState = await taskGuard.readCurrentState();
      if (
        fencedState.authorizationRevision !== 1 ||
        fencedState.searchGeneration !== 2
      ) throw new Error('packed source generation was not persisted');
      await createItem(local, options, localGuard, writer(1), {
        id: 'Q1',
        labels: { en: { language: 'en', value: 'packed local consumer' } },
        authorization: policy(1),
      });
      const materialization = await createSearchMaterializationAdminGuardV1(
        local, options, localWriteCapability,
      );
      await materialization.initialize(searchAdmin(2));
      const materializationReceipt = await materialization.run(searchAdmin(2), {
        maxJobs: 10,
        maxRebuildRoots: 10,
        maxChunkBytes: 64,
        leaseMilliseconds: 30_000,
      });
      if (
        materializationReceipt.completed !== 1 ||
        materializationReceipt.deferred !== 0 ||
        materializationReceipt.dead !== 0
      ) throw new Error('packed materialization did not process Item without attempting blocked Task');
      const blockedTaskJobs = await local.prepare(
        "SELECT COUNT(*) AS count FROM taproot_search_projection_jobs WHERE source_kind = 'task'",
      ).all();
      if (Number(blockedTaskJobs.results[0]?.count) !== 0) {
        throw new Error('packed materialization enqueued blocked Task work');
      }
      const visible = await local.prepare(
        \`SELECT d.document_slot, d.document_text
           FROM taproot_search_installation_state s
           JOIN taproot_search_materialization_heads h
             ON h.corpus_id = s.active_corpus_id AND h.eligible = 1
           JOIN taproot_search_staged_documents d
             ON d.stage_id = h.current_stage_id
           WHERE s.installation_id = ? AND h.root_kind = 'item'
           ORDER BY d.document_slot\`,
      ).bind(installationId).all();
      if (
        visible.results.length !== 1 ||
        visible.results[0]?.document_slot !== 'item' ||
        !String(visible.results[0]?.document_text).includes('packed local consumer')
      ) throw new Error('packed materialization did not publish the Item document');
      const materializationHealth = await materialization.health(searchAdmin(2));
      if (
        materializationHealth.status !== 'blocked' ||
        !materializationHealth.blockedProducerKinds.includes('task') ||
        JSON.stringify(materializationHealth).includes('packed local consumer')
      ) throw new Error('packed materialization health was not blocked and redacted');
      const projectionAuthority = createSearchProjectionAuthorizationAuthorityV1(
        new PersistedEntityAuthorizationSource(local),
      );
      const statementAuthorizationInput = {
        version: 1,
        sourceKind: 'statement',
        sourceId: 'Q1$packed-search',
        sourceRevision: '2',
        sourcePolicyRevision: 2,
        installationId,
        workspaceId: null,
        ownerPrincipalId: 'packed-consumer-principal',
        authorizationRevision: 2,
        visibility: { version: 1, clauses: [] },
      };
      let forgedProjectionAuthorityRejected = false;
      try {
        await createTrustedSearchAuthorizationEnvelopeV1(
          { kind: 'taproot-search-projection-authorization-authority-v1' },
          statementAuthorizationInput,
        );
      } catch {
        forgedProjectionAuthorityRejected = true;
      }
      if (!forgedProjectionAuthorityRejected) {
        throw new Error('request data constructed a trusted projection envelope');
      }
      const statementAuthorization = await createTrustedSearchAuthorizationEnvelopeV1(
        projectionAuthority,
        statementAuthorizationInput,
      );
      const statementPlan = await projectStatementForUnifiedSearchV1({
        source: {
          version: 1,
          eventId: 'packed-search-event',
          operation: 'upsert',
          installationId,
          kind: 'statement',
          sourceId: 'Q1$packed-search',
          sourceRevision: '2',
          sourceHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          sourcePolicyRevision: 2,
          authorizationRevision: 2,
          searchGeneration: 2,
        },
        itemId: 'Q1',
        statement: {
          id: 'Q1$packed-search',
          type: 'statement',
          text: 'Packed projection text.',
          rank: 'normal',
          mainsnak: {
            snaktype: 'value',
            property: 'P1',
            datatype: 'string',
            datavalue: { type: 'string', value: 'not projected' },
          },
          qualifiers: {},
          'qualifiers-order': [],
          references: [],
        },
        authorization: statementAuthorization,
        maxChunkBytes: 8,
      });
      if (
        statementPlan.documents[0]?.text !== 'Packed projection text.' ||
        statementPlan.chunks.map(({ text }) => text).join('') !== 'Packed projection text.' ||
        statementPlan.chunks.some(({ canonical }) => canonical !== false) ||
        new TextDecoder().decode(canonicalSearchBytesV1({ z: null, a: 'e\\u0301' })) !==
          '{"a":"é","z":null}'
      ) {
        throw new Error('packed unified search projection contract failed');
      }
      let sparseCanonicalRejected = false;
      try {
        canonicalSearchBytesV1(Array(1));
      } catch {
        sparseCanonicalRejected = true;
      }
      if (!sparseCanonicalRejected) {
        throw new Error('packed canonical search bytes accepted a sparse array');
      }
      const itemAuthorization = await createTrustedSearchAuthorizationEnvelopeV1(
        projectionAuthority,
        {
          ...statementAuthorizationInput,
          sourceKind: 'item',
          sourceId: 'Q9',
        },
      );
      const separatorPlan = await projectItemForUnifiedSearchV1({
        source: {
          version: 1,
          eventId: 'packed-item-event',
          operation: 'upsert',
          installationId,
          kind: 'item',
          sourceId: 'Q9',
          sourceRevision: '2',
          sourceHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          sourcePolicyRevision: 2,
          authorizationRevision: 2,
          searchGeneration: 2,
        },
        item: {
          id: 'Q9',
          type: 'item',
          labels: { en: { language: 'en', value: 'aaaa' } },
          aliases: { en: [{ language: 'en', value: '🔥' }] },
          descriptions: {},
          claims: {},
          sitelinks: {},
          lastrevid: 2,
          modified: '2026-07-22T00:00:00.000Z',
        },
        authorization: itemAuthorization,
        statementAuthorizations: {},
        mixedScope: 'partition',
        maxChunkBytes: 4,
      });
      if (
        separatorPlan.chunks.map(({ text }) => text).join('|') !== 'aaaa|\\n|🔥' ||
        separatorPlan.chunks.some(({ trace }) => trace.length === 0)
      ) {
        throw new Error('packed projection emitted an untraced separator chunk');
      }
      if (
        'prepareAuthorizationAdvance' in localGuard ||
        'prepareExpectedRevisionFence' in localGuard
      ) {
        throw new Error('guard exposed splittable authorization statements');
      }
      const beforeOmission = await local.prepare(
        'SELECT (SELECT COUNT(*) FROM taproot_entities) AS entities, (SELECT COUNT(*) FROM taproot_entity_authorization) AS policies, (SELECT COUNT(*) FROM taproot_authorization_projection_outbox) AS outbox, authorization_revision AS authorizationRevision FROM taproot_installation_authorization WHERE singleton = 1',
      ).all();
      let omissionRejected = false;
      try {
        await createItem(local, options, localGuard, writer(2), { id: 'Q2' });
      } catch {
        omissionRejected = true;
      }
      if (!omissionRejected) throw new Error('runtime authorization omission committed');
      const afterOmission = await local.prepare(
        'SELECT (SELECT COUNT(*) FROM taproot_entities) AS entities, (SELECT COUNT(*) FROM taproot_entity_authorization) AS policies, (SELECT COUNT(*) FROM taproot_authorization_projection_outbox) AS outbox, authorization_revision AS authorizationRevision FROM taproot_installation_authorization WHERE singleton = 1',
      ).all();
      if (JSON.stringify(beforeOmission.results) !== JSON.stringify(afterOmission.results)) {
        throw new Error('runtime authorization omission left durable side effects');
      }
      for (const forbidden of [
        'TaprootRepository', 'createTaproot', 'getEntity', 'listEntities',
        'searchEntities', 'listAuditEvents', 'exportEntities',
        'inspectEntityIntegrity', 'repairEntityProjection',
      ]) {
        if (forbidden in taprootApi) throw new Error('raw read bypass exported: ' + forbidden);
      }
      let validatorsRejected = false;
      try {
        await createItem(local, { ...options, validators: [] }, localGuard, writer(2), {
          id: 'Q2', authorization: policy(2),
        });
      } catch {
        validatorsRejected = true;
      }
      if (!validatorsRejected) throw new Error('write validator read bypass remained');
      for (const forbiddenOptions of [
        { ...options, factory: {} },
        { ...options, maxEntityBytes: 1 },
      ]) {
        let rejected = false;
        try {
          await createItem(local, forbiddenOptions, localGuard, writer(2), {
            id: 'Q2', authorization: policy(2),
          });
        } catch {
          rejected = true;
        }
        if (!rejected) throw new Error('write configuration read bypass remained');
      }
      for (const forbiddenCapability of [
        undefined,
        localWriteCapability,
        { kind: 'taproot-installation-authorization-guard-v1' },
        JSON.parse(JSON.stringify(localGuard)),
        d1Guard,
      ]) {
        let rejected = false;
        try {
          await createItem(local, options, forbiddenCapability, writer(2), {
            id: 'Q2', authorization: policy(2),
          });
        } catch {
          rejected = true;
        }
        if (!rejected) throw new Error('write capability boundary was forgeable');
      }
      let crossInstallationRejected = false;
      try {
        await createItem(
          local,
          { baseIri: 'https://other.example' },
          localGuard,
          writer(2),
          { id: 'Q2', authorization: policy(2) },
        );
      } catch {
        crossInstallationRejected = true;
      }
      if (!crossInstallationRejected) throw new Error('write capability crossed installation');
      let deepImportRejected = false;
      try {
        await import('@gnolith/taproot/dist/repository.js');
      } catch (error) {
        deepImportRejected = error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
      }
      if (!deepImportRejected) throw new Error('raw repository deep import remained available');
      const schema = await inspectTaprootSchema(local);
      if (!schema.valid) throw new Error('fresh node:sqlite schema inspection failed');
    } finally {
      await local.close();
    }
  `,
);
execFileSync(process.execPath, [join(root, 'smoke.mjs')], {
  cwd: root,
  stdio: 'inherit',
});

const installed = JSON.parse(
  readFileSync(join(root, 'node_modules', packagePath, 'package.json'), 'utf8'),
);
if (
  installed.private !== false ||
  installed.version !== sourcePackage.version
) {
  throw new Error('packed metadata differs from the public source package');
}
for (const path of [
  'SECURITY.md',
  'SUPPORT.md',
  'docs/api.md',
  'docs/threat-model.md',
  'migrations/0001_taproot.sql',
  'migrations/0002_audit_operations.sql',
  'migrations/0003_canonical_statement_text.sql',
  'migrations/0004_canonical_authorization_policy.sql',
  'migrations/0005_unified_search_source_events.sql',
  'migrations/0006_unified_search_materialization_lifecycle.sql',
  'migrations/0007_external_search_producers.sql',
  'migrations/0008_complete_search_content_semantic.sql',
]) {
  if (!existsSync(join(root, 'node_modules', packagePath, path))) {
    throw new Error(`packed artifact is missing ${path}`);
  }
}
console.log(`consumer smoke passed for ${installed.name}@${installed.version}`);
console.log('consumer dependency graph contains one @gnolith/diamond@0.4.1');

function collectDependencyVersions(node, dependencyName) {
  const versions = [];
  for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
    if (name === dependencyName) versions.push(dependency.version);
    versions.push(...collectDependencyVersions(dependency, dependencyName));
  }
  return versions;
}
