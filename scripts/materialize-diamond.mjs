import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DIAMOND_COMMIT = 'e82f58ba8028ff9c16a34f4b8a9a2bc356495b64';
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('materialize:diamond must be run through npm');

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const locked = lock.packages?.['node_modules/@gnolith/diamond'];
assert.equal(locked?.version, '0.5.0');
assert.match(locked?.resolved ?? '', /^file:/);
assert.match(locked?.integrity ?? '', /^sha512-/);
const target = resolve(locked.resolved.slice('file:'.length));

if (!valid(target, locked.integrity)) {
  const source = resolve(argument('--source'));
  assert.equal(
    git(source, 'rev-parse', 'HEAD'),
    DIAMOND_COMMIT,
    'Diamond source checkout is not the pinned commit',
  );
  assert.equal(
    git(source, 'status', '--porcelain=v1', '--untracked-files=no'),
    '',
    'Diamond source checkout has tracked changes',
  );
  npm(source, 'ci');
  mkdirSync(dirname(target), { recursive: true });
  const [packed] = JSON.parse(
    npm(source, 'pack', '--json', '--pack-destination', dirname(target)),
  );
  assert.equal(packed.name, '@gnolith/diamond');
  assert.equal(packed.version, locked.version);
  const generated = resolve(dirname(target), packed.filename);
  if (generated !== target) renameSync(generated, target);
}

assert.ok(
  valid(target, locked.integrity),
  'Diamond tarball integrity mismatch',
);
console.log(
  JSON.stringify({
    dependency: '@gnolith/diamond@0.5.0',
    sourceCommit: DIAMOND_COMMIT,
    target,
    integrity: locked.integrity,
  }),
);

function valid(path, integrity) {
  if (!existsSync(path)) return false;
  const [algorithm, expected] = integrity.split('-', 2);
  return (
    createHash(algorithm).update(readFileSync(path)).digest('base64') ===
    expected
  );
}

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? null : process.argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function git(directory, ...args) {
  return execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
  }).trim();
}

function npm(directory, ...args) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd: directory,
    encoding: 'utf8',
  });
}
