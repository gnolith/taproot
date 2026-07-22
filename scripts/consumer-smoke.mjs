import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
const [{ filename, integrity, shasum }] = JSON.parse(packOutput);
const archive = join(root, filename);
const diamondSpec = process.env.DIAMOND_TARBALL
  ? resolve(process.env.DIAMOND_TARBALL)
  : '@gnolith/diamond@0.4.0';
const taprootSha256 = createHash('sha256')
  .update(readFileSync(archive))
  .digest('hex');
if (process.env.DIAMOND_TARBALL) {
  const diamondSha256 = createHash('sha256')
    .update(readFileSync(diamondSpec))
    .digest('hex');
  console.log(`Diamond packed artifact sha256=${diamondSha256}`);
}
console.log(
  `Taproot packed artifact sha256=${taprootSha256} integrity=${integrity} shasum=${shasum}`,
);

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
    diamondSpec,
    'miniflare@^4.20260714.0',
  ],
  { stdio: 'inherit' },
);
writeFileSync(
  join(root, 'smoke.mjs'),
  `
    import { createSparqlHandler } from '@gnolith/diamond';
    import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
    import * as taprootApi from '@gnolith/taproot';
    import {
      addStatement,
      bootstrapTaprootAuthorization,
      createItem,
      createProperty,
      createInstallationAuthorizationGuard,
      createTaprootHostWriteCapability,
      initializeTaproot,
      inspectTaprootSchema,
      KNOWLEDGE_POLICY_CAPABILITY,
      KNOWLEDGE_WRITE_CAPABILITY,
    } from '@gnolith/taproot';
    import { Miniflare } from 'miniflare';

    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-07-19',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: crypto.randomUUID() },
    });
    const installationId = 'packed-consumer-installation';
    const writer = (authorizationRevision, policyAuthority = false) => ({
      installationId,
      principalId: 'packed-consumer-principal',
      activeWorkspaceId: null,
      workspaceIds: [],
      capabilities: [
        KNOWLEDGE_WRITE_CAPABILITY,
        ...(policyAuthority ? [KNOWLEDGE_POLICY_CAPABILITY] : []),
      ],
      authorizationRevision,
    });
    const policy = (expectedAuthorizationRevision, statementRestrictions = {}) => ({
      installationId,
      workspaceId: null,
      ownerPrincipalId: 'packed-consumer-principal',
      visibility: { version: 1, clauses: [] },
      statementRestrictions,
      expectedAuthorizationRevision,
    });
    let d1Guard;
    try {
      const db = await miniflare.getD1Database('DB');
      const options = { baseIri: 'https://knowledge.example' };
      await initializeTaproot(db, options);
      const d1WriteCapability = createTaprootHostWriteCapability(
        db,
        options,
        await crypto.subtle.generateKey(
          { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
        ),
      );
      await bootstrapTaprootAuthorization(
        db, options, d1WriteCapability, installationId,
      );
      d1Guard = await createInstallationAuthorizationGuard(
        db, options, d1WriteCapability,
      );
      await createProperty(db, options, d1Guard, writer(1), {
        id: 'P1', datatype: 'string', authorization: policy(1),
      });
      const item = await createItem(db, options, d1Guard, writer(2), {
        id: 'Q1',
        labels: { en: { language: 'en', value: 'clean consumer' } },
        authorization: policy(2),
      });
      if ('entity' in item || 'quadPatch' in item || item.status !== 'committed') {
        throw new Error('public write receipt disclosed canonical state');
      }
      await addStatement(
        db,
        options,
        d1Guard,
        writer(3, true),
        'Q1',
        {
          id: 'Q1$consumer',
          type: 'statement',
          text: 'The packed Taproot consumer works.',
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
        {
          expectedRevision: item.newRevision,
          authorization: policy(3, { 'Q1$consumer': [] }),
        },
      );
      const query = 'ASK { <https://knowledge.example/entity/Q1> <https://knowledge.example/prop/direct/P1> "works" }';
      const response = await createSparqlHandler({ db })(
        new Request('https://consumer.example/sparql?query=' + encodeURIComponent(query), {
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

    const local = new NodeSqliteDatabase(':memory:');
    try {
      const options = { baseIri: 'https://local.example' };
      await initializeTaproot(local, options);
      const localWriteCapability = createTaprootHostWriteCapability(
        local,
        options,
        await crypto.subtle.generateKey(
          { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
        ),
      );
      await bootstrapTaprootAuthorization(
        local, options, localWriteCapability, installationId,
      );
      const localGuard = await createInstallationAuthorizationGuard(
        local, options, localWriteCapability,
      );
      await createItem(local, options, localGuard, writer(1), {
        id: 'Q1',
        labels: { en: { language: 'en', value: 'packed local consumer' } },
        authorization: policy(1),
      });
      for (const forbidden of [
        'TaprootRepository', 'createTaproot', 'getEntity', 'listEntities',
        'searchEntities', 'listAuditEvents', 'exportEntities',
        'inspectEntityIntegrity', 'repairEntityProjection',
      ]) {
        if (forbidden in taprootApi) throw new Error('raw read bypass exported: ' + forbidden);
      }
      let validatorsRejected = false;
      try {
        await createItem(local, { ...options, validators: [] }, localGuard, writer(2), {
          id: 'Q2', authorization: policy(2),
        });
      } catch {
        validatorsRejected = true;
      }
      if (!validatorsRejected) throw new Error('write validator read bypass remained');
      for (const forbiddenOptions of [
        { ...options, factory: {} },
        { ...options, maxEntityBytes: 1 },
      ]) {
        let rejected = false;
        try {
          await createItem(local, forbiddenOptions, localGuard, writer(2), {
            id: 'Q2', authorization: policy(2),
          });
        } catch {
          rejected = true;
        }
        if (!rejected) throw new Error('write configuration read bypass remained');
      }
      for (const forbiddenCapability of [
        undefined,
        localWriteCapability,
        { kind: 'taproot-installation-authorization-guard-v1' },
        JSON.parse(JSON.stringify(localGuard)),
        d1Guard,
      ]) {
        let rejected = false;
        try {
          await createItem(local, options, forbiddenCapability, writer(2), {
            id: 'Q2', authorization: policy(2),
          });
        } catch {
          rejected = true;
        }
        if (!rejected) throw new Error('write capability boundary was forgeable');
      }
      let crossInstallationRejected = false;
      try {
        await createItem(
          local,
          { baseIri: 'https://other.example' },
          localGuard,
          writer(2),
          { id: 'Q2', authorization: policy(2) },
        );
      } catch {
        crossInstallationRejected = true;
      }
      if (!crossInstallationRejected) throw new Error('write capability crossed installation');
      let deepImportRejected = false;
      try {
        await import('@gnolith/taproot/dist/repository.js');
      } catch (error) {
        deepImportRejected = error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
      }
      if (!deepImportRejected) throw new Error('raw repository deep import remained available');
      const schema = await inspectTaprootSchema(local);
      if (!schema.valid) throw new Error('fresh node:sqlite schema inspection failed');
    } finally {
      await local.close();
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
  'migrations/0003_canonical_statement_text.sql',
  'migrations/0004_canonical_authorization_policy.sql',
]) {
  if (!existsSync(join(root, 'node_modules', packagePath, path))) {
    throw new Error(`packed artifact is missing ${path}`);
  }
}
console.log(`consumer smoke passed for ${installed.name}@${installed.version}`);
