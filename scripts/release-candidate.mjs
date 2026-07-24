import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('release:candidate must be run through npm');

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const output = resolve(argument('--output'));
const tag = optionalArgument('--tag') ?? `v${packageJson.version}`;
assert.equal(tag, `v${packageJson.version}`, 'tag must match package version');
assert.equal(
  git('status', '--porcelain=v1', '--untracked-files=no'),
  '',
  'release candidates require a clean tracked worktree',
);

const commit = git('rev-parse', 'HEAD');
const tree = git('rev-parse', 'HEAD^{tree}');
mkdirSync(output, { recursive: true });

const packOutput = npm('pack', '--json', '--pack-destination', output);
const [packed] = JSON.parse(packOutput);
assert.equal(packed.name, packageJson.name);
assert.equal(packed.version, packageJson.version);
const packagePath = resolve(output, packed.filename);
const packageBytes = readFileSync(packagePath);
const packageSha256 = sha256(packageBytes);

const rawSbom = JSON.parse(
  npm('sbom', '--omit=dev', '--sbom-format', 'cyclonedx'),
);
assert.equal(rawSbom.bomFormat, 'CycloneDX');
assert.equal(rawSbom.metadata?.component?.name, 'taproot');
assert.equal(rawSbom.metadata?.component?.version, packageJson.version);
const componentNames = new Set(
  (rawSbom.components ?? []).map(({ name }) => name),
);
for (const dependency of Object.keys(packageJson.dependencies ?? {}))
  assert.ok(
    componentNames.has(dependency),
    `runtime SBOM is missing direct dependency ${dependency}`,
  );
for (const developmentDependency of Object.keys(
  packageJson.devDependencies ?? {},
))
  assert.ok(
    !componentNames.has(developmentDependency),
    `runtime SBOM contains development dependency ${developmentDependency}`,
  );

delete rawSbom.serialNumber;
delete rawSbom.metadata.timestamp;
rawSbom.metadata.component.hashes = [
  { alg: 'SHA-1', content: packed.shasum },
  { alg: 'SHA-256', content: packageSha256 },
];
rawSbom.metadata.properties = [
  ...(rawSbom.metadata.properties ?? []).filter(
    ({ name }) => !String(name).startsWith('gnolith:'),
  ),
  {
    name: 'gnolith:package:integrity',
    value: packed.integrity,
  },
  {
    name: 'gnolith:source:commit',
    value: commit,
  },
  {
    name: 'gnolith:source:repository',
    value: packageJson.repository.url,
  },
  {
    name: 'gnolith:source:tree',
    value: tree,
  },
].sort((left, right) => left.name.localeCompare(right.name));
rawSbom.components.sort((left, right) =>
  String(left['bom-ref']).localeCompare(String(right['bom-ref'])),
);
rawSbom.dependencies.sort((left, right) =>
  String(left.ref).localeCompare(String(right.ref)),
);
for (const dependency of rawSbom.dependencies)
  dependency.dependsOn?.sort((left, right) => left.localeCompare(right));

const sbomFilename = `gnolith-taproot-${packageJson.version}.cdx.json`;
const sbomPath = resolve(output, sbomFilename);
const sbomBytes = Buffer.from(`${JSON.stringify(stable(rawSbom), null, 2)}\n`);
writeFileSync(sbomPath, sbomBytes);
const sbomSha256 = sha256(sbomBytes);

const provenanceFilename = `gnolith-taproot-${packageJson.version}.provenance.json`;
const provenancePath = resolve(output, provenanceFilename);
const provenance = {
  format: 'gnolith-release-candidate-provenance-v1',
  source: {
    repository: packageJson.repository.url,
    commit,
    tree,
  },
  package: {
    name: packageJson.name,
    version: packageJson.version,
    tag,
    filename: packed.filename,
    bytes: packageBytes.byteLength,
    unpackedBytes: packed.unpackedSize,
    files: packed.entryCount,
    sha1: packed.shasum,
    sha256: packageSha256,
    integrity: packed.integrity,
  },
  sbom: {
    filename: sbomFilename,
    format: `${rawSbom.bomFormat} ${rawSbom.specVersion} JSON`,
    bytes: sbomBytes.byteLength,
    sha256: sbomSha256,
    components: rawSbom.components.length,
    dependencyGraphNodes: rawSbom.dependencies.length,
    scope: 'runtime dependencies; development dependencies omitted',
  },
  generator: {
    script: 'scripts/release-candidate.mjs',
    packageManager: packageJson.packageManager,
  },
};
const provenanceBytes = Buffer.from(
  `${JSON.stringify(stable(provenance), null, 2)}\n`,
);
writeFileSync(provenancePath, provenanceBytes);
const provenanceSha256 = sha256(provenanceBytes);

const sums = [
  [packageSha256, packed.filename],
  [sbomSha256, sbomFilename],
  [provenanceSha256, provenanceFilename],
]
  .map(([digest, filename]) => `${digest}  ${filename}`)
  .join('\n');
writeFileSync(resolve(output, 'SHA256SUMS'), `${sums}\n`);

for (const [digest, filename] of [
  [packageSha256, packed.filename],
  [sbomSha256, sbomFilename],
  [provenanceSha256, provenanceFilename],
])
  assert.equal(
    sha256(readFileSync(resolve(output, filename))),
    digest,
    `${filename} checksum changed after write`,
  );
assert.equal(statSync(packagePath).size, packed.size);

console.log(
  JSON.stringify({
    output,
    source: { commit, tree },
    package: provenance.package,
    sbom: provenance.sbom,
    provenance: {
      filename: provenanceFilename,
      bytes: provenanceBytes.byteLength,
      sha256: provenanceSha256,
    },
    checksums: 'SHA256SUMS',
  }),
);

function argument(name) {
  const value = optionalArgument(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function npm(...args) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    encoding: 'utf8',
  });
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  return value;
}
