import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('usage: check-codeql-sarif.mjs SARIF_DIRECTORY');

async function findSarif(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await findSarif(path)));
    else if (entry.isFile() && entry.name.endsWith('.sarif')) files.push(path);
  }
  return files;
}

const files = await findSarif(root);
if (files.length === 0) throw new Error(`no SARIF files found under ${root}`);
let findings = 0;
for (const file of files) {
  const sarif = JSON.parse(await readFile(file, 'utf8'));
  for (const run of sarif.runs ?? []) findings += run.results?.length ?? 0;
}
console.log(`CodeQL SARIF: ${files.length} file(s), ${findings} finding(s)`);
if (findings > 0) process.exitCode = 1;
