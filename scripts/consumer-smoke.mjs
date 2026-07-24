import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
    import * as taproot from '@gnolith/taproot';
    import * as search from '@gnolith/taproot/search';
    import * as backup from '@gnolith/taproot/backup';
    import * as sparql from '@gnolith/taproot/sparql-policy';
    const db = new NodeSqliteDatabase(':memory:');
    const target = new NodeSqliteDatabase(':memory:');
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
    } finally {
      await db.close();
      await target.close();
    }
  `,
);
execFileSync(process.execPath, [join(root, 'smoke.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
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
