import {
  checksumMigration,
  createMigrationAssemblyAuthorityV1,
  createMigrationLedgerBackupV1,
  migrateDiamondStore,
  registerMigrationLedgerOwnerV1,
} from '@gnolith/diamond';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { describe, expect, it } from 'vitest';
import {
  convertLegacyTaproot042ToBackupSectionV1,
  importTaprootBackupSectionV1,
  inspectLegacyTaproot042ForAdoptionV1,
  legacyTaproot042MigrationManifestV1,
  registerTaprootMigrationLedgerOwnerHandleV1,
} from '../src/backup.js';
import { createTaprootHostWriteCapability } from '../src/index.js';
import {
  taprootMigrationNamespace,
  taprootMigrations,
} from '../src/migrations.js';
import {
  initializeTaproot,
  inspectTaprootSchema,
  taprootPreArchitectureResetSchemaStatements,
} from '../src/schema.js';

describe('Taproot 0.4.2 owner adoption', () => {
  it('emits a bounded read-only owner fragment with exact ledger evidence', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    try {
      await createExact042(db);
      const before = await db
        .prepare(`SELECT total_changes() AS changes`)
        .all<{ changes: number }>();
      const fragment = await inspectLegacyTaproot042ForAdoptionV1(db, {
        packageName: '@gnolith/taproot',
        packageVersion: '0.4.2',
      });
      const after = await db
        .prepare(`SELECT total_changes() AS changes`)
        .all<{ changes: number }>();
      expect(fragment).toMatchObject({
        format: 'taproot-legacy-local-v1-owner-fragment-v1',
        schemaVersion: '7',
        installationId: 'legacy-installation',
        canonicalDisposition: 'import',
        derivedDisposition: 'rebuild',
        domainCounts: {
          items: 0,
          properties: 0,
          statements: 0,
          resources: 0,
          annotations: 0,
          revisions: 0,
        },
        ledger: {
          format: 'diamond-migration-ledger-slice-v1',
          namespace: '@gnolith/taproot',
        },
      });
      expect(fragment.ledger.entries).toHaveLength(8);
      expect(fragment.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(after.results[0]?.changes).toBe(before.results[0]?.changes);
    } finally {
      await db.close();
    }
  });

  it('rejects a forged version attestation and post-reset state', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    try {
      await createExact042(db);
      await expect(
        inspectLegacyTaproot042ForAdoptionV1(db, {
          packageName: '@gnolith/taproot',
          packageVersion: '0.4.1' as '0.4.2',
        }),
      ).rejects.toThrow();
      await db
        .prepare(
          `CREATE TABLE taproot_authorization_bootstraps(id TEXT PRIMARY KEY) STRICT`,
        )
        .run();
      await expect(
        inspectLegacyTaproot042ForAdoptionV1(db, {
          packageName: '@gnolith/taproot',
          packageVersion: '0.4.2',
        }),
      ).rejects.toThrow(/pre-reset/u);
    } finally {
      await db.close();
    }
  });

  it('rejects checksum drift and keeps immutable 0.4.2 evidence independent of current migrations', async () => {
    expect(legacyTaproot042MigrationManifestV1).toHaveLength(8);
    const current = await Promise.all(
      taprootMigrations.slice(0, 8).map(async (migration) => ({
        id: migration.id,
        checksum: await checksumMigration(migration),
      })),
    );
    expect(current).not.toEqual(legacyTaproot042MigrationManifestV1);
    const db = new NodeSqliteDatabase(':memory:');
    try {
      await createExact042(db);
      await db
        .prepare(
          `UPDATE _gnolith_migrations SET checksum=?
           WHERE namespace=? AND migration_id=?`,
        )
        .bind(
          '0'.repeat(64),
          taprootMigrationNamespace,
          legacyTaproot042MigrationManifestV1[7].id,
        )
        .run();
      await expect(
        inspectLegacyTaproot042ForAdoptionV1(db, {
          packageName: '@gnolith/taproot',
          packageVersion: '0.4.2',
        }),
      ).rejects.toThrow(/ledger is not exact/u);
    } finally {
      await db.close();
    }
  });

  it('converts only a live inspected fragment to a current owner section', async () => {
    const source = new NodeSqliteDatabase(':memory:');
    const target = new NodeSqliteDatabase(':memory:');
    try {
      await createExact042(source);
      const fragment = await inspectLegacyTaproot042ForAdoptionV1(source, {
        packageName: '@gnolith/taproot',
        packageVersion: '0.4.2',
      });
      const baseIri = 'https://target.example';
      await initializeTaproot(target, { baseIri });
      const assembly = createMigrationAssemblyAuthorityV1(
        target,
        'target-installation',
      );
      const diamondOwner = await registerMigrationLedgerOwnerV1({
        db: target,
        installationId: 'target-installation',
        namespace: taprootMigrationNamespace,
        migrations: taprootMigrations,
        assemblyAuthority: assembly,
      });
      const ledgerBackup = createMigrationLedgerBackupV1(target, assembly);
      const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const capability = createTaprootHostWriteCapability(
        target,
        { baseIri },
        key,
      );
      const handle = registerTaprootMigrationLedgerOwnerHandleV1(
        target,
        { baseIri },
        capability,
        diamondOwner,
        ledgerBackup,
      );
      const section = await convertLegacyTaproot042ToBackupSectionV1(
        target,
        fragment,
        handle,
      );
      expect(section.ledger.entries).toHaveLength(9);
      expect(section.legacySourceLedger?.entries).toHaveLength(8);
      const converted = JSON.parse(
        new TextDecoder().decode(section.canonicalPayload),
      ) as {
        tables: {
          taproot_metadata: Array<{
            metadata_key: string;
            metadata_value: string;
          }>;
          taproot_migrations: Array<{ version: number; name: string }>;
        };
      };
      expect(
        converted.tables.taproot_metadata.find(
          (row) => row.metadata_key === 'schema_version',
        )?.metadata_value,
      ).toBe('9');
      expect(converted.tables.taproot_migrations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            version: 9,
            name: 'architecture-reset',
          }),
        ]),
      );
      await expect(
        importTaprootBackupSectionV1(target, section, handle, {
          dryRun: true,
        }),
      ).resolves.toMatchObject({ dryRun: true });
      await target
        .prepare(
          `UPDATE taproot_metadata SET metadata_value='8'
           WHERE metadata_key='schema_version'`,
        )
        .run();
      await expect(
        importTaprootBackupSectionV1(target, section, handle),
      ).rejects.toThrow(/schema seeds are not current/u);
      await target
        .prepare(
          `UPDATE taproot_metadata SET metadata_value='9'
           WHERE metadata_key='schema_version'`,
        )
        .run();
      await expect(
        importTaprootBackupSectionV1(target, section, handle),
      ).resolves.toMatchObject({ dryRun: false });
      await expect(inspectTaprootSchema(target)).resolves.toMatchObject({
        valid: true,
        versions: { schema_version: '9' },
      });
      await expect(
        convertLegacyTaproot042ToBackupSectionV1(
          target,
          { ...fragment },
          handle,
        ),
      ).rejects.toThrow(/live/u);
    } finally {
      await source.close();
      await target.close();
    }
  });
});

async function createExact042(db: NodeSqliteDatabase): Promise<void> {
  await migrateDiamondStore(db);
  const appliedAt = '2026-07-23T00:00:00.000Z';
  await db.batch([
    ...taprootPreArchitectureResetSchemaStatements.map((sql) =>
      db.prepare(sql),
    ),
    db
      .prepare(
        `INSERT INTO taproot_metadata(metadata_key, metadata_value)
         VALUES ('base_iri', ?), ('migration_api_version', '1')`,
      )
      .bind('https://legacy.example'),
    db.prepare(
      `INSERT INTO taproot_installation_authorization(
         singleton, installation_id, authorization_revision,
         search_generation, last_advance_id, created_at, updated_at
       ) VALUES (
         1, 'legacy-installation', 1, 1, 'bootstrap',
         '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z'
       )`,
    ),
    ...legacyTaproot042MigrationManifestV1.map(({ id, checksum }) =>
      db
        .prepare(
          `INSERT INTO _gnolith_migrations(
             namespace, migration_id, checksum, adopted, applied_at
           ) VALUES (?, ?, ?, 0, ?)`,
        )
        .bind(taprootMigrationNamespace, id, checksum, appliedAt),
    ),
  ]);
}
