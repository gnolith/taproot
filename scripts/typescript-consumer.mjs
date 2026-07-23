import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';

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
  `import type { AuthorizationContext, D1DatabaseLike } from '@gnolith/taproot';
  import type {
    ExternalProducer,
    ExternalSearchKind,
    RegisteredExternalProducerV1,
    SearchMaterializationHealthV1,
  } from '@gnolith/taproot/search';
  import type {
    LegacyTaproot042AdoptionFragmentV1,
    ResourceBlobDescriptor,
  } from '@gnolith/taproot/backup';

  declare const db: D1DatabaseLike;
  declare const context: AuthorizationContext;
  declare const producer: ExternalProducer;
  declare const registeredProducer: RegisteredExternalProducerV1;
  declare const kind: ExternalSearchKind;
  declare const health: SearchMaterializationHealthV1;
  declare const fragment: LegacyTaproot042AdoptionFragmentV1;
  declare const blob: ResourceBlobDescriptor;
  const predecessor = await registeredProducer.currentPredecessor('source-1');
  if (predecessor) {
    const eventId: string = predecessor.eventId;
    const sequence: number = predecessor.sequence;
    void [eventId, sequence];
  }
  void [db, context, producer, kind, health, fragment, blob];
  `,
);
const diamond =
  process.env.DIAMOND_TARBALL ?? resolve('node_modules', '@gnolith', 'diamond');
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
