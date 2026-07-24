import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('consumer smoke must be run through npm');
const root = mkdtempSync(join(tmpdir(), 'taproot-consumer-'));
const sourcePackage = JSON.parse(readFileSync('package.json', 'utf8'));
const packOutput = execFileSync(
  process.execPath,
  [npmCli, 'pack', '--json', '--pack-destination', root],
  { encoding: 'utf8' },
);
const [{ filename }] = JSON.parse(packOutput);
const archive = join(root, filename);
const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
const diamond =
  process.env.DIAMOND_TARBALL ?? resolve('node_modules', '@gnolith', 'diamond');
const exactLegacySnapshot =
  process.env.TAPROOT_EXACT_LEGACY_SNAPSHOT ??
  resolve(
    '..',
    'seedbed',
    'fixtures',
    'legacy-local-v1',
    'legacy-local-v1.snapshot',
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
    diamond,
  ],
  { stdio: 'inherit' },
);
const tree = JSON.parse(
  execFileSync(
    process.execPath,
    [npmCli, 'ls', '@gnolith/diamond', '--all', '--json', '--prefix', root],
    { encoding: 'utf8' },
  ),
);
const versions = collectDependencyVersions(tree, '@gnolith/diamond');
const uniqueVersions = [...new Set(versions)];
if (uniqueVersions.length !== 1 || uniqueVersions[0] !== '0.5.0')
  throw new Error(`consumer requires one Diamond 0.5.0; found ${versions}`);
writeFileSync(
  join(root, 'smoke.mjs'),
  `
    import {
      createMigrationAssemblyAuthorityV1,
      createMigrationLedgerBackupV1,
      migrateDiamondStore,
      registerMigrationLedgerOwnerV1,
    } from '@gnolith/diamond';
    import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
    import { createHash } from 'node:crypto';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { gunzipSync } from 'node:zlib';
    import * as taproot from '@gnolith/taproot';
    import * as search from '@gnolith/taproot/search';
    import * as backup from '@gnolith/taproot/backup';
    import * as sparql from '@gnolith/taproot/sparql-policy';
    const db = new NodeSqliteDatabase(':memory:');
    const target = new NodeSqliteDatabase(':memory:');
    const searchDb = new NodeSqliteDatabase(':memory:');
    try {
      await taproot.initializeTaproot(db, { baseIri: 'https://consumer.example' });
      const inspection = await taproot.inspectTaprootSchema(db);
      if (!inspection.valid) throw new Error('packed schema is invalid');
      for (const name of [
        'createInstallationDomainMutationGuard',
        'createInstallationSearchSourceGuardV1',
        'createTaprootInstallationSnapshotV1',
        'restoreTaprootInstallationSnapshotV1',
      ]) if (name in taproot) throw new Error('removed bridge exported: ' + name);
      if (typeof taproot.createTaprootWorkshopPortV1 !== 'function')
        throw new Error('missing export: createTaprootWorkshopPortV1');
      for (const [module, names] of [
        [search, ['createAuthorizedSearchServiceV1', 'registerExternalProducerKindV1', 'registerExternalProducerV1']],
        [backup, ['inspectLegacyTaproot042ForAdoptionV1', 'exportTaprootBackupSectionV1']],
        [sparql, ['prepareScopedSparqlPolicyV1']],
      ]) for (const name of names) {
        if (typeof module[name] !== 'function') throw new Error('missing export: ' + name);
      }
      const installationId = 'packed-restore-installation';
      const now = '2026-07-23T00:00:00.000Z';
      await db.batch([
        db.prepare(\`INSERT INTO taproot_installation_authorization(
          singleton, installation_id, authorization_revision,
          search_generation, last_advance_id, created_at, updated_at
        ) VALUES (1, ?, 1, 1, 'bootstrap', ?, ?)\`).bind(installationId, now, now),
        db.prepare(\`INSERT INTO taproot_authorization_principals(
          installation_id, principal_id, created_at
        ) VALUES (?, 'principal-1', ?)\`).bind(installationId, now),
        db.prepare(\`INSERT INTO taproot_authorization_workspaces(
          installation_id, workspace_id, created_at
        ) VALUES (?, 'workspace-1', ?)\`).bind(installationId, now),
        db.prepare(\`INSERT INTO taproot_authorization_grants(
          installation_id, principal_id, workspace_id, capability,
          authorization_revision, created_at
        ) VALUES (?, 'principal-1', 'workspace-1', 'knowledge:write', 1, ?)\`).bind(installationId, now),
      ]);
      const sourceAssembly = createMigrationAssemblyAuthorityV1(db, installationId);
      const sourceOwner = await registerMigrationLedgerOwnerV1({
        db,
        installationId,
        namespace: taproot.taprootMigrationNamespace,
        migrations: taproot.taprootMigrations,
        assemblyAuthority: sourceAssembly,
      });
      const sourceLedgerBackup = createMigrationLedgerBackupV1(db, sourceAssembly);
      const sourceKey = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const sourceHandle = backup.registerTaprootMigrationLedgerOwnerHandleV1(
        db,
        { baseIri: 'https://consumer.example' },
        taproot.createTaprootHostWriteCapability(
          db,
          { baseIri: 'https://consumer.example' },
          sourceKey,
        ),
        sourceOwner,
        sourceLedgerBackup,
      );
      const section = await backup.exportTaprootBackupSectionV1(
        db,
        installationId,
        sourceHandle,
      );
      await migrateDiamondStore(target);
      const targetAssembly = createMigrationAssemblyAuthorityV1(target, installationId);
      const targetOwner = await registerMigrationLedgerOwnerV1({
        db: target,
        installationId,
        namespace: taproot.taprootMigrationNamespace,
        migrations: taproot.taprootMigrations,
        assemblyAuthority: targetAssembly,
      });
      const targetLedgerBackup = createMigrationLedgerBackupV1(target, targetAssembly);
      await targetLedgerBackup.restoreNamespace(targetOwner, section.ledger, { mode: 'empty' });
      const targetKey = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const targetHandle = backup.registerTaprootMigrationLedgerOwnerHandleV1(
        target,
        { baseIri: 'https://consumer.example' },
        taproot.createTaprootHostWriteCapability(
          target,
          { baseIri: 'https://consumer.example' },
          targetKey,
        ),
        targetOwner,
        targetLedgerBackup,
      );
      await backup.importTaprootBackupSectionV1(
        target,
        section,
        targetHandle,
        { dryRun: true },
      );
      await backup.importTaprootBackupSectionV1(target, section, targetHandle);
      const restored = await target.prepare(
        'SELECT COUNT(*) AS count FROM taproot_authorization_grants',
      ).all();
      if (Number(restored.results[0]?.count ?? 0) !== 1)
        throw new Error('packed owner restore lost authorization grants');

      await taproot.initializeTaproot(searchDb, {
        baseIri: 'https://packed-search.example',
      });
      const searchKey = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const searchAuthority = taproot.createTaprootHostWriteCapability(
        searchDb,
        { baseIri: 'https://packed-search.example' },
        searchKey,
      );
      await taproot.bootstrapTaprootAuthorization(
        searchDb,
        { baseIri: 'https://packed-search.example' },
        searchAuthority,
        'packed-search-installation',
      );
      await searchDb.batch([
        searchDb.prepare(
          \`INSERT INTO taproot_authorization_principals(
             installation_id, principal_id, created_at
           ) VALUES ('packed-search-installation', 'admin', ?)\`,
        ).bind(now),
        searchDb.prepare(
          \`INSERT INTO taproot_authorization_workspaces(
             installation_id, workspace_id, created_at
           ) VALUES ('packed-search-installation', 'packed-admin', ?)\`,
        ).bind(now),
        searchDb.prepare(
          \`INSERT INTO taproot_authorization_grants(
             installation_id, principal_id, workspace_id, capability,
             authorization_revision, created_at
           ) VALUES (
             'packed-search-installation', 'admin', 'packed-admin',
             'search:admin', 1, ?
           )\`,
        ).bind(now),
      ]);
      const adminContext = {
        installationId: 'packed-search-installation',
        principalId: 'admin',
        activeWorkspaceId: null,
        workspaceIds: [],
        capabilities: ['search:admin'],
        authorizationRevision: 1,
      };
      const materialization = await search.createSearchMaterializationAdminGuardV1(
        searchDb,
        { baseIri: 'https://packed-search.example' },
        searchAuthority,
      );
      await materialization.initialize(adminContext);
      await searchDb.prepare(
        'CREATE TABLE packed_owner_records(source_id TEXT PRIMARY KEY, revision TEXT NOT NULL) STRICT',
      ).run();
      const externalKind = await search.registerExternalProducerKindV1(
        searchDb,
        { baseIri: 'https://packed-search.example' },
        searchAuthority,
        {
          installationId: 'packed-search-installation',
          namespace: 'packed.example',
          localName: 'task',
          ownerDomain: 'packed-owner',
          adapter: {
            kind: 'taproot-external-owner-transaction-adapter-v1',
            prepare(token) {
              return Promise.resolve([
                searchDb.prepare(
                  \`INSERT INTO packed_owner_records(source_id, revision)
                   VALUES (?, ?) ON CONFLICT(source_id)
                   DO UPDATE SET revision=excluded.revision\`,
                ).bind(token.sourceId, token.revision),
              ]);
            },
          },
        },
      );
      const packedSource = {
        sourceId: 'packed-task-1',
        sourceRevision: '1',
        sourcePolicyRevision: 1,
        canonical: { title: 'Packed task' },
      };
      const packedProducer = await search.registerExternalProducerV1(
        searchDb,
        { baseIri: 'https://packed-search.example' },
        searchAuthority,
        {
          descriptor: {
            registration: externalKind.registration,
            implementationVersion: '1.0.0',
            fingerprint: 'f'.repeat(64),
            projectionVersion: 'packed-task-v1',
            changeClasses: ['canonical'],
          },
          enumerate: () => Promise.resolve({ ids: [packedSource.sourceId], cursor: null }),
          loadExact: () => Promise.resolve(packedSource),
          project: () => Promise.resolve({ text: 'packed task lexical result' }),
          authorize: () => Promise.resolve(true),
          hydrate: () => Promise.resolve(packedSource.canonical),
        },
      );
      let predecessor = null;
      for (const revision of ['1', '2']) {
        packedSource.sourceRevision = revision;
        const participant = await packedProducer.issuer.seal({
          sourceId: packedSource.sourceId,
          sourceRevision: revision,
          predecessor,
          ownerMutationToken: {
            sourceId: packedSource.sourceId,
            revision,
          },
        });
        await packedProducer.commit(participant);
        predecessor = await packedProducer.currentPredecessor(
          packedSource.sourceId,
        );
      }
      const packedRun = await materialization.run(adminContext, {
        maxJobs: 10,
        maxRebuildRoots: 10,
      });
      if (packedRun.completed !== 1 || packedRun.superseded !== 1)
        throw new Error('packed materialization did not process supersession');
      const packedHealth = await materialization.health(adminContext);
      if (
        packedHealth.status !== 'healthy' ||
        packedHealth.pendingJobs !== 0 ||
        packedHealth.sourceHighWatermark !== 2 ||
        packedHealth.activeAppliedWatermark !== 2
      ) throw new Error('packed materialization health did not converge');
      const packedSearch = search.createAuthorizedSearchServiceV1(searchDb, {
        installationId: 'packed-search-installation',
      });
      const packedPage = await packedSearch.search(
        { text: 'packed task lexical', kinds: [packedProducer.kind] },
        { ...adminContext, capabilities: [] },
      );
      if (
        packedPage.results.length !== 1 ||
        packedPage.results[0].sourceId !== packedSource.sourceId
      ) throw new Error('packed external lexical search lost its result');
      const packedEmpty = await packedSearch.search(
        { text: 'absent lexical value', kinds: [packedProducer.kind] },
        { ...adminContext, capabilities: [] },
      );
      if (packedEmpty.results.length !== 0)
        throw new Error('packed external lexical empty query was not safe');

      const semantic = search.createSemanticSearchAdminV1(searchDb, {
        installationId: 'packed-search-installation',
        fetch: async (_input, init) => {
          if (init?.redirect !== 'error')
            throw new Error('packed semantic redirect policy was not enforced');
          return new Response(JSON.stringify({
            embeddings: [[1, 0]],
            usage: { total_tokens: 1 },
          }), { status: 200 });
        },
        resolveCredential: selector =>
          selector === 'packed-ollama' ? 'packed-runtime-secret' : undefined,
      });
      await semantic.configure({
        version: 1,
        id: 'packed-semantic',
        name: 'packed-semantic',
        provider: {
          kind: 'ollama-compatible',
          endpoint: 'http://127.0.0.1:11434',
          model: 'packed-model',
          dimensions: 2,
          metric: 'cosine',
          credentialSelector: 'packed-ollama',
          allowPrivateEndpoint: true,
          redirectPolicy: 'error',
        },
        vector: { kind: 'sqlite' },
      }, {
        expectedRevision: 0,
        idempotencyKey: 'packed-semantic-v1',
      }, adminContext);
      const packedSemantic = await searchDb.prepare(
        \`SELECT configuration_revision, provider_credential_selector
         FROM taproot_semantic_configurations
         WHERE configuration_id='packed-semantic'\`,
      ).all();
      if (
        Number(packedSemantic.results[0]?.configuration_revision) !== 1 ||
        packedSemantic.results[0]?.provider_credential_selector !== 'packed-ollama'
      ) throw new Error('packed semantic configuration was not durable');

      const administrationOwner =
        await taproot.registerAuthorizationAdministrationOwnerV1(
          searchDb,
          { baseIri: 'https://packed-search.example' },
          searchAuthority,
          {
            installationId: 'packed-search-installation',
            ownerRegistrationId: 'packed-workshop-owner',
            adapter: {
              kind: 'taproot-authorization-administration-owner-adapter-v1',
              prepare: () => Promise.resolve({
                statements: [],
                receipt: { selector: 'packed-owner-selector' },
              }),
            },
          },
        );
      const administration =
        await taproot.prepareAuthorizationAdministrationV1(
          searchDb,
          { baseIri: 'https://packed-search.example' },
          searchAuthority,
          {
            installationId: 'packed-search-installation',
            expectedAuthorizationRevision: 1,
            idempotencyKey: 'packed-workspace-2',
            command: {
              type: 'put-workspace',
              workspaceId: 'packed-workspace-2',
            },
          },
          adminContext,
        );
      const administrationReceipt =
        await taproot.commitAuthorizationAdministrationV1(
          administration,
          await administrationOwner.seal(administration, {}),
        );
      if (
        administrationReceipt.authorizationRevision !== 2 ||
        administrationReceipt.searchGeneration <= 1
      ) throw new Error('packed authorization administration did not advance');

      const legacySnapshotPath = process.env.TAPROOT_EXACT_LEGACY_SNAPSHOT;
      if (legacySnapshotPath) {
        const snapshotBytes = readFileSync(legacySnapshotPath);
        if (
          createHash('sha256').update(snapshotBytes).digest('hex') !==
          '7e9722a1a1d993e13207d5bb2900e2f7e5457ee70c572566c6c9ddb2e637d736'
        ) throw new Error('exact legacy snapshot hash changed');
        const snapshot = JSON.parse(gunzipSync(snapshotBytes));
        if (
          snapshot.manifest?.format !== 'gnolith-seedbed-snapshot-v1' ||
          snapshot.manifest?.packages?.diamond !== '0.4.1' ||
          snapshot.manifest?.packages?.taproot !== '0.4.2' ||
          snapshot.manifest?.packages?.workshop !== '0.4.2' ||
          snapshot.manifest?.packages?.seedbed !== '0.3.2'
        ) throw new Error('exact legacy tuple manifest changed');
        const legacyDatabaseBytes = Buffer.from(snapshot.database, 'base64');
        if (
          createHash('sha256').update(legacyDatabaseBytes).digest('hex') !==
          snapshot.manifest.database.sha256
        ) throw new Error('exact legacy database hash changed');
        const legacyDatabasePath = join(process.cwd(), 'exact-legacy.sqlite');
        writeFileSync(legacyDatabasePath, legacyDatabaseBytes);
        const legacyDb = new NodeSqliteDatabase(legacyDatabasePath);
        try {
          const fragment = await backup.inspectLegacyTaproot042ForAdoptionV1(
            legacyDb,
            {
              packageName: '@gnolith/taproot',
              packageVersion: '0.4.2',
            },
          );
          const expectedCounts = {
            items: 1,
            properties: 1,
            statements: 1,
            resources: 1,
            annotations: 1,
            revisions: 8,
          };
          if (JSON.stringify(fragment.domainCounts) !== JSON.stringify(expectedCounts))
            throw new Error('packed exact legacy tuple counts changed');
          const descriptor = fragment.blobDescriptors[0];
          if (
            fragment.blobDescriptors.length !== 1 ||
            descriptor.referenceId !== 'fixture/payload.txt' ||
            descriptor.resourceId !== 'fixture-resource' ||
            descriptor.revision !== 2 ||
            descriptor.byteLength !== 35 ||
            descriptor.sha256 !==
              '9fc576a110e5c41d15e4e51630c974a7dfc3edcea06ff92cfa720ded5a4210ce'
          ) throw new Error('packed exact legacy payload evidence changed');
          const canonical = JSON.parse(
            new TextDecoder().decode(fragment.canonicalPayload),
          );
          const resource = JSON.parse(
            canonical.tables.taproot_resources[0].record_json,
          );
          const annotation = JSON.parse(
            canonical.tables.taproot_annotations[0].record_json,
          );
          if (
            resource.revision !== 2 ||
            resource.title !== 'Fixture resource revision two' ||
            annotation.revision !== 2 ||
            annotation.body?.text !==
              'Fixture annotation body, revision two.'
          ) throw new Error('packed exact legacy revision evidence changed');

          const legacyTarget = new NodeSqliteDatabase(':memory:');
          try {
            await taproot.initializeTaproot(legacyTarget, {
              baseIri: fragment.baseIri,
            });
            const legacyAssembly = createMigrationAssemblyAuthorityV1(
              legacyTarget,
              fragment.installationId,
            );
            const legacyOwner = await registerMigrationLedgerOwnerV1({
              db: legacyTarget,
              installationId: fragment.installationId,
              namespace: taproot.taprootMigrationNamespace,
              migrations: taproot.taprootMigrations,
              assemblyAuthority: legacyAssembly,
            });
            const legacyLedgerBackup = createMigrationLedgerBackupV1(
              legacyTarget,
              legacyAssembly,
            );
            const legacyKey = await crypto.subtle.generateKey(
              { name: 'HMAC', hash: 'SHA-256' },
              false,
              ['sign'],
            );
            const legacyHandle =
              backup.registerTaprootMigrationLedgerOwnerHandleV1(
                legacyTarget,
                { baseIri: fragment.baseIri },
                taproot.createTaprootHostWriteCapability(
                  legacyTarget,
                  { baseIri: fragment.baseIri },
                  legacyKey,
                ),
                legacyOwner,
                legacyLedgerBackup,
              );
            const converted =
              await backup.convertLegacyTaproot042ToBackupSectionV1(
                legacyTarget,
                fragment,
                legacyHandle,
              );
            await backup.importTaprootBackupSectionV1(
              legacyTarget,
              converted,
              legacyHandle,
            );
            const ready = await taproot.inspectTaprootSchema(legacyTarget);
            if (!ready.valid || ready.versions.schema_version !== '9')
              throw new Error('packed legacy import is not migration-ready');
            const currentLedger = await legacyLedgerBackup.exportNamespace(
              legacyOwner,
            );
            if (
              currentLedger.entries.length !== 9 ||
              currentLedger.entries[8]?.id !== '0009-architecture-reset'
            ) throw new Error('packed legacy import lost current ledger');
            const roundTrip = await backup.exportTaprootBackupSectionV1(
              legacyTarget,
              fragment.installationId,
              legacyHandle,
            );
            const importedCanonical = JSON.parse(
              new TextDecoder().decode(roundTrip.canonicalPayload),
            );
            const importedResource = JSON.parse(
              importedCanonical.tables.taproot_resources[0].record_json,
            );
            const importedAnnotation = JSON.parse(
              importedCanonical.tables.taproot_annotations[0].record_json,
            );
            if (
              importedCanonical.tables.taproot_entities.length !== 2 ||
              importedCanonical.tables.taproot_entity_revisions.length +
                importedCanonical.tables.taproot_content_revisions.length !==
                8 ||
              importedResource.title !== 'Fixture resource revision two' ||
              importedAnnotation.body?.text !==
                'Fixture annotation body, revision two.'
            ) throw new Error('packed legacy import lost canonical evidence');
          } finally {
            await legacyTarget.close();
          }
        } finally {
          await legacyDb.close();
        }
      }
    } finally {
      await db.close();
      await target.close();
      await searchDb.close();
    }
  `,
);
execFileSync(process.execPath, [join(root, 'smoke.mjs')], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    ...(existsSync(exactLegacySnapshot)
      ? { TAPROOT_EXACT_LEGACY_SNAPSHOT: exactLegacySnapshot }
      : {}),
  },
});
if (existsSync(exactLegacySnapshot)) {
  const crossProcessSmoke = join(root, 'legacy-cross-process-smoke.mjs');
  writeFileSync(
    crossProcessSmoke,
    readFileSync(resolve('scripts', 'legacy-cross-process-smoke.mjs'), 'utf8'),
  );
  execFileSync(
    process.execPath,
    [
      crossProcessSmoke,
      'run',
      exactLegacySnapshot,
      join(root, 'legacy-section.json'),
    ],
    { cwd: root, stdio: 'inherit' },
  );
}
console.log(
  `consumer smoke passed for ${sourcePackage.name}@${sourcePackage.version}; sha256=${sha256}`,
);

function collectDependencyVersions(node, dependencyName) {
  const versions = [];
  for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
    if (name === dependencyName) versions.push(dependency.version);
    versions.push(...collectDependencyVersions(dependency, dependencyName));
  }
  return versions;
}
