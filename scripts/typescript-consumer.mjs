import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('TypeScript consumer must be run through npm');

const root = mkdtempSync(join(tmpdir(), 'taproot-typescript-consumer-'));
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
writeFileSync(
  join(root, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: false,
      noEmit: true,
      lib: ['ES2022', 'DOM'],
    },
    include: ['consumer.ts'],
  }),
);
writeFileSync(
  join(root, 'consumer.ts'),
  `import type {
    AuthorizationContext,
    D1DatabaseLike,
    ExternalSearchDomainMutationBindingV1,
    ExternalSearchProducerCallbacksV1,
    SearchMaterializationHealthV1,
  } from '@gnolith/taproot';

  declare const db: D1DatabaseLike;
  declare const context: AuthorizationContext;
  declare const callbacks: ExternalSearchProducerCallbacksV1;
  const binding: ExternalSearchDomainMutationBindingV1 = {
    domain: 'workshop',
    sourceKind: 'task',
    capability: 'task:write',
    changeClasses: ['canonical'],
  };
  declare const health: SearchMaterializationHealthV1;
  void [db, context, callbacks, binding, health];
  `,
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
    'typescript@5.9.2',
  ],
  { stdio: 'inherit' },
);
execFileSync(
  process.execPath,
  [join(root, 'node_modules', 'typescript', 'bin', 'tsc')],
  { cwd: root, stdio: 'inherit' },
);
const installed = JSON.parse(
  readFileSync(
    join(root, 'node_modules', '@gnolith', 'taproot', 'package.json'),
    'utf8',
  ),
);
console.log(
  `strict TypeScript consumer passed for ${installed.name}@${installed.version}`,
);
