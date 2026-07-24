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
    import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
    import * as taproot from '@gnolith/taproot';
    import * as search from '@gnolith/taproot/search';
    import * as backup from '@gnolith/taproot/backup';
    import * as sparql from '@gnolith/taproot/sparql-policy';
    const db = new NodeSqliteDatabase(':memory:');
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
    } finally {
      await db.close();
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
