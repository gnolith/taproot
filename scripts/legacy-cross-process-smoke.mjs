import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash, subtle } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { TextDecoder, TextEncoder } from 'node:util';
import { gunzipSync } from 'node:zlib';
import {
  createMigrationAssemblyAuthorityV1,
  createMigrationLedgerBackupV1,
  migrateDiamondStore,
  registerMigrationLedgerOwnerV1,
} from '@gnolith/diamond';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import * as taproot from '@gnolith/taproot';
import * as backup from '@gnolith/taproot/backup';

const expectedSnapshotSha256 =
  '7e9722a1a1d993e13207d5bb2900e2f7e5457ee70c572566c6c9ddb2e637d736';
const [phase, snapshotPath, exchangePath] = process.argv.slice(2);

if (phase === 'run') {
  execFileSync(
    process.execPath,
    [import.meta.filename, 'convert', snapshotPath, exchangePath],
    { stdio: 'inherit' },
  );
  execFileSync(
    process.execPath,
    [import.meta.filename, 'import-fresh', snapshotPath, exchangePath],
    { stdio: 'inherit' },
  );
  execFileSync(
    process.execPath,
    [import.meta.filename, 'import-raw', snapshotPath, exchangePath],
    { stdio: 'inherit' },
  );
  execFileSync(
    process.execPath,
    [import.meta.filename, 'import-existing', snapshotPath, exchangePath],
    { stdio: 'inherit' },
  );
  console.log('packed exact legacy cross-process adoption passed');
} else if (phase === 'convert') {
  const snapshotBytes = readFileSync(snapshotPath);
  assert(
    sha256(snapshotBytes) === expectedSnapshotSha256,
    'exact legacy snapshot hash changed',
  );
  const snapshot = JSON.parse(gunzipSync(snapshotBytes));
  const legacyBytes = Buffer.from(snapshot.database, 'base64');
  assert(
    sha256(legacyBytes) === snapshot.manifest.database.sha256,
    'exact legacy database hash changed',
  );
  const legacyPath = `${exchangePath}.sqlite`;
  writeFileSync(legacyPath, legacyBytes);
  const legacyDb = new NodeSqliteDatabase(legacyPath);
  const converter = new NodeSqliteDatabase(':memory:');
  try {
    const fragment = await backup.inspectLegacyTaproot042ForAdoptionV1(
      legacyDb,
      {
        packageName: '@gnolith/taproot',
        packageVersion: '0.4.2',
      },
    );
    assert(
      JSON.stringify(fragment.domainCounts) ===
        JSON.stringify({
          items: 1,
          properties: 1,
          statements: 1,
          resources: 1,
          annotations: 1,
          revisions: 8,
        }),
      'exact legacy Taproot counts changed',
    );
    const runtime = await initializeTarget(
      converter,
      fragment.installationId,
      fragment.baseIri,
    );
    await converter
      .prepare(`UPDATE taproot_migrations SET applied_at='converter-process'`)
      .run();
    const section = await backup.convertLegacyTaproot042ToBackupSectionV1(
      converter,
      fragment,
      runtime.handle,
    );
    writeFileSync(exchangePath, JSON.stringify(serializeSection(section)));
  } finally {
    await legacyDb.close();
    await converter.close();
  }
} else if (
  phase === 'import-fresh' ||
  phase === 'import-raw' ||
  phase === 'import-existing'
) {
  const snapshotBytes = readFileSync(snapshotPath);
  assert(
    sha256(snapshotBytes) === expectedSnapshotSha256,
    'exact legacy snapshot hash changed',
  );
  const snapshot = JSON.parse(gunzipSync(snapshotBytes));
  const section = deserializeSection(
    JSON.parse(readFileSync(exchangePath, 'utf8')),
  );
  const target = new NodeSqliteDatabase(':memory:');
  try {
    const importBaseIri =
      phase === 'import-existing'
        ? 'https://independent-import-target.invalid/gnolith'
        : snapshot.manifest.baseIri;
    const runtime =
      phase === 'import-fresh' || phase === 'import-raw'
        ? await registerBlankTarget(
            target,
            snapshot.manifest.installationId,
            importBaseIri,
          )
        : await initializeTarget(
            target,
            snapshot.manifest.installationId,
            importBaseIri,
          );
    if (phase === 'import-fresh') {
      await backup.restoreTaprootMigrationLedgerV1(
        target,
        runtime.handle,
        section.ledger,
      );
      const restored = await taproot.inspectTaprootPersistence(target);
      assert(
        restored.current === true,
        'blank ledger restore did not converge to current persistence',
      );
    }
    if (phase === 'import-raw')
      await runtime.ledgerBackup.restoreNamespace(
        runtime.owner,
        section.ledger,
        { mode: 'empty' },
      );
    await target
      .prepare(`UPDATE taproot_migrations SET applied_at='importer-process'`)
      .run();

    const versionTamper = cloneSection(section);
    const versionPayload = JSON.parse(
      new TextDecoder().decode(versionTamper.canonicalPayload),
    );
    versionPayload.tables.taproot_metadata.find(
      (row) => row.metadata_key === 'schema_version',
    ).metadata_value = '8';
    versionTamper.canonicalPayload = new TextEncoder().encode(
      canonicalJson(versionPayload),
    );
    await rehashSection(versionTamper);
    await assertRejects(
      backup.importTaprootBackupSectionV1(
        target,
        versionTamper,
        runtime.handle,
      ),
      'schema version tamper was accepted',
    );

    const checksumTamper = cloneSection(section);
    checksumTamper.ledger.entries[8].checksum = '0'.repeat(64);
    await rehashSection(checksumTamper);
    await assertRejects(
      backup.importTaprootBackupSectionV1(
        target,
        checksumTamper,
        runtime.handle,
      ),
      'migration checksum tamper was accepted',
    );

    await backup.importTaprootBackupSectionV1(target, section, runtime.handle);
    const ready = await taproot.inspectTaprootSchema(target);
    assert(
      ready.valid && ready.versions.schema_version === '9',
      'cross-process import is not migration-ready',
    );
    if (phase !== 'import-existing') {
      const persistence = await taproot.inspectTaprootPersistence(target);
      assert(
        persistence.current === true,
        `cross-process import is not current: ${JSON.stringify(
          persistence.readinessErrors,
        )}`,
      );
    }
    const appliedAt = await target
      .prepare(
        `SELECT COUNT(*) AS count FROM taproot_migrations
         WHERE applied_at='importer-process'`,
      )
      .all();
    assert(
      Number(appliedAt.results[0]?.count) === 9,
      'cross-process import overwrote current migration provenance',
    );
    const baseIri = await target
      .prepare(
        `SELECT metadata_value FROM taproot_metadata
         WHERE metadata_key='base_iri'`,
      )
      .all();
    assert(
      baseIri.results[0]?.metadata_value === importBaseIri,
      'cross-process import overwrote current installation metadata',
    );
    const ledger = await runtime.ledgerBackup.exportNamespace(runtime.owner);
    assert(
      ledger.entries.length === 9 &&
        ledger.entries[8]?.id === '0009-architecture-reset',
      'cross-process import lost the current migration ledger',
    );
    const roundTrip = await backup.exportTaprootBackupSectionV1(
      target,
      snapshot.manifest.installationId,
      runtime.handle,
    );
    const canonical = JSON.parse(
      new TextDecoder().decode(roundTrip.canonicalPayload),
    );
    assert(
      canonical.tables.taproot_entities.length === 2 &&
        canonical.tables.taproot_entity_revisions.length +
          canonical.tables.taproot_content_revisions.length ===
          8 &&
        canonical.tables.taproot_resources.length === 1 &&
        canonical.tables.taproot_annotations.length === 1,
      'cross-process import lost exact legacy domain evidence',
    );
  } finally {
    await target.close();
  }
} else {
  throw new Error(`unknown cross-process smoke phase: ${phase}`);
}

async function initializeTarget(db, installationId, baseIri) {
  await taproot.initializeTaproot(db, { baseIri });
  return registerTarget(db, installationId, baseIri);
}

async function registerBlankTarget(db, installationId, baseIri) {
  await migrateDiamondStore(db);
  return registerTarget(db, installationId, baseIri);
}

async function registerTarget(db, installationId, baseIri) {
  const assembly = createMigrationAssemblyAuthorityV1(db, installationId);
  const owner = await registerMigrationLedgerOwnerV1({
    db,
    installationId,
    namespace: taproot.taprootMigrationNamespace,
    migrations: taproot.taprootMigrations,
    assemblyAuthority: assembly,
  });
  const ledgerBackup = createMigrationLedgerBackupV1(db, assembly);
  const key = await subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const handle = backup.registerTaprootMigrationLedgerOwnerHandleV1(
    db,
    { baseIri },
    taproot.createTaprootHostWriteCapability(db, { baseIri }, key),
    owner,
    ledgerBackup,
  );
  return { owner, ledgerBackup, handle };
}

function serializeSection(section) {
  return {
    ...section,
    canonicalPayload: Buffer.from(section.canonicalPayload).toString('base64'),
    ...(section.derivedPayload
      ? {
          derivedPayload: Buffer.from(section.derivedPayload).toString(
            'base64',
          ),
        }
      : {}),
  };
}

function deserializeSection(section) {
  return {
    ...section,
    canonicalPayload: Buffer.from(section.canonicalPayload, 'base64'),
    ...(section.derivedPayload
      ? { derivedPayload: Buffer.from(section.derivedPayload, 'base64') }
      : {}),
  };
}

function cloneSection(section) {
  return deserializeSection(
    JSON.parse(JSON.stringify(serializeSection(section))),
  );
}

async function rehashSection(section) {
  const canonicalSha256 = sha256(section.canonicalPayload);
  section.sha256 = sha256(
    new TextEncoder().encode(
      canonicalJson({
        owner: 'taproot',
        formatVersion: 1,
        schemaVersion: section.schemaVersion,
        ledger: section.ledger,
        legacySourceLedger: section.legacySourceLedger,
        canonicalSha256,
        derivedState: 'rebuildable',
        legacyAdoptionSha256: section.legacyAdoptionSha256,
      }),
    ),
  );
}

function canonicalJson(value) {
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertRejects(promise, message) {
  try {
    await promise;
  } catch {
    return;
  }
  throw new Error(message);
}
