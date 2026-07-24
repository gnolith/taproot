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
  `import {
    createTaprootWorkshopPortV1,
    type AuthorizationContext,
    type D1DatabaseLike,
    type TaprootHostWriteCapability,
    type TaprootWorkshopPortV1,
  } from '@gnolith/taproot';
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
  declare const authority: TaprootHostWriteCapability;
  declare const context: AuthorizationContext;
  declare const workshop: TaprootWorkshopPortV1;
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
  const port = await createTaprootWorkshopPortV1(
    db,
    { baseIri: 'https://consumer.example' },
    authority,
    { installationId: context.installationId },
  );
  const live = await port.resolveAuthorization({
    principalId: context.principalId,
    activeWorkspaceId: context.activeWorkspaceId,
  });
  await workshop.statementHistory('Q1$statement', { limit: 50 }, live);
  await workshop.statementRevision('Q1$statement', 1, live);
  await workshop.resourceHistory('resource-1', { limit: 50 }, live);
  await workshop.resourceRevision('resource-1', 1, live);
  await workshop.hydrateResource('resource-1', 1, live);
  await workshop.annotationHistory('annotation-1', { limit: 50 }, live);
  await workshop.annotationRevision('annotation-1', 1, live);
  await workshop.createProperty(
    { id: 'P1', datatype: 'string' },
    { idempotencyKey: 'create-property-1' },
    live,
  );
  await workshop.createItem(
    { id: 'Q1' },
    { idempotencyKey: 'create-item-1' },
    live,
  );
  await workshop.mutateEntity(
    'Q1',
    [{
      command: { type: 'set-label', language: 'en', value: 'Example' },
      authoredText: 'Set the English label to Example',
    }],
    { expectedRevision: 1, idempotencyKey: 'set-label-1' },
    live,
  );
  declare const resourceInput: Parameters<TaprootWorkshopPortV1['createResource']>[0];
  declare const annotationInput: Parameters<TaprootWorkshopPortV1['createAnnotation']>[0];
  await workshop.createResource(resourceInput, { idempotencyKey: 'create-resource-1' }, live);
  await workshop.updateResource('resource-1', 1, resourceInput, { idempotencyKey: 'update-resource-1' }, live);
  await workshop.deleteResource('resource-1', 2, { idempotencyKey: 'delete-resource-1' }, live);
  await workshop.createAnnotation(annotationInput, { idempotencyKey: 'create-annotation-1' }, live);
  await workshop.updateAnnotation('annotation-1', 1, annotationInput, { idempotencyKey: 'update-annotation-1' }, live);
  await workshop.deleteAnnotation('annotation-1', 2, { idempotencyKey: 'delete-annotation-1' }, live);
  void [db, context, producer, kind, health, fragment, blob, port];
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
