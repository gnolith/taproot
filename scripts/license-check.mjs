import { execFileSync } from 'node:child_process';

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error('npm_execpath is unavailable; run this check through npm');
}

const sbom = JSON.parse(
  execFileSync(
    process.execPath,
    [npmCli, 'sbom', '--omit=dev', '--sbom-format', 'cyclonedx'],
    {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    },
  ),
);

const allowedLicenses = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'FreeBSD',
  'ISC',
  'MIT',
  'UNLICENSED',
  '(WTFPL OR MIT)',
  'Apache-2.0 AND LGPL-3.0-or-later AND MIT',
]);

// npm's CycloneDX generator does not translate these packages' legacy
// `licenses` arrays, although both packages declare their licenses there.
const legacyLicenseDeclarations = new Map([
  ['pkg:npm/negotiate@1.0.1', 'FreeBSD'],
  ['pkg:npm/uritemplate@0.3.4', 'MIT'],
]);

const components = [
  ...(sbom.metadata?.component ? [sbom.metadata.component] : []),
  ...(sbom.components ?? []),
];
const failures = [];
const counts = new Map();

for (const component of components) {
  const declared = (component.licenses ?? []).map(
    (entry) => entry.expression ?? entry.license?.id ?? entry.license?.name,
  );
  const licenses =
    declared.length > 0
      ? declared
      : [legacyLicenseDeclarations.get(component.purl)].filter(Boolean);

  if (licenses.length === 0) {
    failures.push(
      `${component.name}@${component.version}: no license declared`,
    );
    continue;
  }

  for (const license of licenses) {
    counts.set(license, (counts.get(license) ?? 0) + 1);
    if (!allowedLicenses.has(license)) {
      failures.push(
        `${component.name}@${component.version}: disallowed license ${license}`,
      );
    }
  }
}

if (failures.length > 0) {
  throw new Error(`production license check failed:\n${failures.join('\n')}`);
}

console.log(
  `Production licenses OK (${components.length} components): ${[
    ...counts.entries(),
  ]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([license, count]) => `${license}=${count}`)
    .join(', ')}`,
);
