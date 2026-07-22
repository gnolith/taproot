import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('release:check must be run through npm');

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const tag = process.argv[2] ?? process.env.RELEASE_TAG;
assert.ok(
  tag,
  'Pass the release tag, for example: npm run release:check -- v0.1.0',
);
assert.match(
  packageJson.version,
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/,
  'package version must be valid SemVer',
);
assert.notEqual(packageJson.version, '0.0.0', 'choose a release version first');
assert.equal(tag, `v${packageJson.version}`, 'tag must match package version');
assert.equal(
  packageJson.repository?.url,
  'https://github.com/gnolith/taproot.git',
  'repository URL must match the provenance source repository',
);
if (process.env.GITHUB_REPOSITORY_VISIBILITY === 'public') {
  assert.equal(
    packageJson.private,
    false,
    'public releases must be publishable',
  );
}

const changelog = readFileSync('CHANGELOG.md', 'utf8');
assert.ok(
  changelog.includes(`## ${packageJson.version}`) ||
    changelog.includes(`## [${packageJson.version}]`),
  'CHANGELOG.md must contain a heading for the release version',
);

const packOutput = execFileSync(
  process.execPath,
  [npmCli, 'pack', '--dry-run', '--json'],
  { encoding: 'utf8' },
);
const [artifact] = JSON.parse(packOutput);
const files = new Set(artifact.files.map(({ path }) => path));
for (const required of [
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'SUPPORT.md',
  'dist/index.js',
  'dist/index.d.ts',
  'docs/api.md',
  'docs/architecture.md',
  'docs/search-source-events.md',
  'docs/threat-model.md',
  'examples/d1-diamond-interop/README.md',
  'examples/d1-diamond-interop/demo.ts',
  'migrations/0001_taproot.sql',
  'migrations/0002_audit_operations.sql',
  'migrations/0003_canonical_statement_text.sql',
  'migrations/0004_canonical_authorization_policy.sql',
  'migrations/0005_unified_search_source_events.sql',
]) {
  assert.ok(files.has(required), `packed artifact is missing ${required}`);
}

console.log(
  `release metadata and ${files.size}-file artifact validated for ${tag}`,
);
