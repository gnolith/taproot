import { execFileSync } from 'node:child_process';
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
const [{ filename }] = JSON.parse(packOutput);
const archive = join(root, filename);

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
    '@gnolith/diamond@^0.3.2',
    'miniflare@^4.20260714.0',
  ],
  { stdio: 'inherit' },
);
writeFileSync(
  join(root, 'smoke.mjs'),
  `
    import { createSparqlHandler } from '@gnolith/diamond';
    import {
      TaprootRepository,
      initializeTaproot,
      inspectTaprootSchema,
    } from '@gnolith/taproot';
    import { Miniflare } from 'miniflare';

    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-07-19',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: crypto.randomUUID() },
    });
    try {
      const db = await miniflare.getD1Database('DB');
      await initializeTaproot(db);
      const taproot = new TaprootRepository(db, {
        baseIri: 'https://knowledge.example',
      });
      await taproot.createProperty({ id: 'P1', datatype: 'string' });
      const item = await taproot.createItem({
        id: 'Q1',
        labels: { en: { language: 'en', value: 'clean consumer' } },
      });
      await taproot.addStatement(
        'Q1',
        {
          id: 'Q1$consumer',
          type: 'statement',
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
        { expectedRevision: item.newRevision },
      );
      const query = 'ASK { <https://knowledge.example/entity/Q1> <https://knowledge.example/prop/direct/P1> "works" }';
      const response = await createSparqlHandler({ db })(
        new Request('https://site.example/sparql?query=' + encodeURIComponent(query), {
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
]) {
  if (!existsSync(join(root, 'node_modules', packagePath, path))) {
    throw new Error(`packed artifact is missing ${path}`);
  }
}
console.log(`consumer smoke passed for ${installed.name}@${installed.version}`);
