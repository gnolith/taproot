import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const requiredFiles = [
  'LICENSE',
  'README.md',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'GOVERNANCE.md',
  'SECURITY.md',
  'SUPPORT.md',
  '.github/CODEOWNERS',
  '.github/dependabot.yml',
  '.github/pull_request_template.md',
  '.github/ISSUE_TEMPLATE/bug.yml',
  '.github/ISSUE_TEMPLATE/feature.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/security.yml',
  '.github/workflows/release.yml',
  'docs/api.md',
  'docs/architecture.md',
  'docs/completion-audit.md',
  'docs/operations.md',
  'docs/search-source-events.md',
  'docs/search-materialization.md',
  'docs/product-scope.md',
  'docs/release-policy.md',
  'docs/testing.md',
  'docs/threat-model.md',
  'examples/d1-diamond-interop/README.md',
  'examples/d1-diamond-interop/demo.ts',
  'migrations/0001_taproot.sql',
  'migrations/0002_audit_operations.sql',
  'migrations/0003_canonical_statement_text.sql',
  'migrations/0004_canonical_authorization_policy.sql',
  'migrations/0005_unified_search_source_events.sql',
  'migrations/0006_unified_search_materialization_lifecycle.sql',
  'benchmarks/search-source-events-100k.json',
  'benchmarks/search-materialization-100k.json',
  'scripts/search-source-event-baseline.mjs',
  'scripts/search-materialization-baseline.mjs',
  'scripts/consumer-smoke.mjs',
  'scripts/release-check.mjs',
];

const repositoryFiles = execFileSync('git', [
  'ls-files',
  '--cached',
  '--others',
  '--exclude-standard',
  '-z',
])
  .toString('utf8')
  .split('\0')
  .filter((file) => file && existsSync(file));
const repositoryFileSet = new Set(repositoryFiles);
for (const file of requiredFiles) {
  assert.ok(repositoryFileSet.has(file), `required file is missing: ${file}`);
}

assert.ok(
  !repositoryFiles.some(
    (file) =>
      file === '.openai/hosting.json' || file.endsWith('/.openai/hosting.json'),
  ),
  'hosting configuration belongs to the Site-creating agent',
);

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(packageJson.name, '@gnolith/taproot');
assert.equal(packageJson.license, 'MIT');
assert.equal(packageJson.private, false);
assert.equal(packageJson.publishConfig?.access, 'public');
assert.equal(packageJson.publishConfig?.provenance, true);
assert.match(packageJson.engines?.node ?? '', /^>=22/);
assert.equal(
  packageJson.repository?.url,
  'https://github.com/gnolith/taproot.git',
);
for (const value of Object.values(packageJson.dependencies ?? {})) {
  assert.doesNotMatch(value, /^(?:file:|link:)/, 'local dependency is present');
}

for (const workflow of repositoryFiles.filter((file) =>
  file.startsWith('.github/workflows/'),
)) {
  const text = readFileSync(workflow, 'utf8');
  for (const match of text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
    assert.match(
      match[1],
      /@[0-9a-f]{40}$/,
      `${workflow} action is not pinned to a full commit: ${match[1]}`,
    );
  }
}

const prohibitedPath =
  /(?:[A-Za-z]:\\Users\\[^\s"']+|\/Users\/[^\s"']+|\/home\/[^\s"']+)/;
for (const file of repositoryFiles.filter(
  (path) =>
    !path.endsWith('package-lock.json') &&
    !path.endsWith('.tgz') &&
    !path.match(/\.(?:png|jpe?g|gif|webp|ico|pdf)$/i),
)) {
  assert.doesNotMatch(
    readFileSync(file, 'utf8'),
    prohibitedPath,
    `${file} contains a local user path`,
  );
}

const release = readFileSync('.github/workflows/release.yml', 'utf8');
for (const required of [
  'environment: release',
  'id-token: write',
  'tag_type="$(git cat-file -t "refs/tags/$GITHUB_REF_NAME")"',
  'test "$tag_type" = tag',
  'npm run release:check',
  'npm sbom',
  'sha256sum',
  'actions/attest-build-provenance@',
  'npm publish ./*.tgz --access public --provenance',
]) {
  assert.ok(
    release.includes(required),
    `release workflow is missing: ${required}`,
  );
}
assert.ok(
  !release.includes('NPM_TOKEN'),
  'release workflow contains NPM_TOKEN',
);
assert.ok(
  !release.includes('NODE_AUTH_TOKEN'),
  'release workflow contains NODE_AUTH_TOKEN',
);

console.log(
  `package repository structure validated: ${requiredFiles.length} required files, ` +
    `${repositoryFiles.length} repository files, pinned Actions, clean local paths, no hosting config`,
);
