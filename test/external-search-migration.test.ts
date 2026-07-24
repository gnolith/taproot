import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checksumMigration, migrateDiamondStore } from '@gnolith/diamond';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyTaprootMigrations,
  inspectTaprootPersistence,
  taprootMigrationNamespace,
  taprootMigrations,
} from '../src/migrations.js';
import { taprootPreArchitectureResetSchemaStatements } from '../src/schema.js';

const baseIri = 'https://architecture-upgrade.example';
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('populated architecture-reset migration', () => {
  it('atomically adopts closed-enum producer data into a generic namespace across restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'taproot-0009-upgrade-'));
    directories.push(directory);
    const path = join(directory, 'taproot.sqlite');
    const first = new NodeSqliteDatabase(path);
    try {
      await createExact0008(first);
      const now = '2026-07-23T00:00:00.000Z';
      await first.batch([
        first
          .prepare(
            `INSERT INTO taproot_installation_authorization(
               singleton, installation_id, authorization_revision,
               search_generation, last_advance_id, created_at, updated_at
             ) VALUES (1, 'installation', 1, 1, 'bootstrap', ?, ?)`,
          )
          .bind(now, now),
        first
          .prepare(
            `INSERT INTO taproot_unified_search_producer_manifests(
               installation_id, source_kind, producer_fingerprint,
               owning_domain, contract_version, projection_version,
               authorization_contract_version, manifest_revision, created_at
             ) VALUES (
               'installation', 'task', ?, 'workshop',
               'legacy-contract', 'legacy-projection',
               'legacy-authorization', 1, ?
             )`,
          )
          .bind('f'.repeat(64), now),
        first
          .prepare(
            `INSERT INTO taproot_unified_search_producer_adoptions(
               installation_id, source_kind, producer_fingerprint, state,
               enumerated_count, adopted_count, manifest_revision, updated_at
             ) VALUES ('installation','task',?,'ready',1,1,1,?)`,
          )
          .bind('f'.repeat(64), now),
      ]);
      await expect(
        applyTaprootMigrations(first, { baseIri }),
      ).resolves.toMatchObject({ current: true });
      const adopted = await first
        .prepare(
          `SELECT namespace, local_name, owner_domain, storage_key
           FROM taproot_external_search_kind_registrations`,
        )
        .all<{
          namespace: string;
          local_name: string;
          owner_domain: string;
          storage_key: string;
        }>();
      expect(adopted.results).toEqual([
        {
          namespace: 'legacy',
          local_name: 'task',
          owner_domain: 'workshop',
          storage_key: 'external:6:legacy:task',
        },
      ]);
      const adoption = await first
        .prepare(
          `SELECT source_kind, state
           FROM taproot_unified_search_producer_adoptions
           WHERE source_kind LIKE 'external:%'`,
        )
        .all<{ source_kind: string; state: string }>();
      expect(adoption.results).toEqual([
        { source_kind: 'external:6:legacy:task', state: 'ready' },
      ]);
      const activeDdl = await first
        .prepare(
          `SELECT group_concat(sql, ' ') AS ddl FROM sqlite_schema
           WHERE name LIKE 'taproot_%'`,
        )
        .all<{ ddl: string }>();
      expect(activeDdl.results[0]?.ddl).not.toContain(
        "'task', 'memory', 'prompt'",
      );
    } finally {
      await first.close();
    }
    const reopened = new NodeSqliteDatabase(path);
    try {
      await expect(inspectTaprootPersistence(reopened)).resolves.toMatchObject({
        current: true,
        baseIri,
      });
    } finally {
      await reopened.close();
    }
  });
});

async function createExact0008(db: NodeSqliteDatabase): Promise<void> {
  await migrateDiamondStore(db);
  const appliedAt = '2026-07-23T00:00:00.000Z';
  const predecessors = await Promise.all(
    taprootMigrations.slice(0, 8).map(async (migration) => ({
      migration,
      checksum: await checksumMigration(migration),
    })),
  );
  await db.batch([
    ...taprootPreArchitectureResetSchemaStatements.map((sql) =>
      db.prepare(sql),
    ),
    db
      .prepare(
        `INSERT INTO taproot_metadata(metadata_key, metadata_value)
         VALUES ('base_iri', ?), ('migration_api_version', '1')`,
      )
      .bind(baseIri),
    ...predecessors.map(({ migration, checksum }) =>
      db
        .prepare(
          `INSERT INTO _gnolith_migrations(
             namespace, migration_id, checksum, adopted, applied_at
           ) VALUES (?, ?, ?, 0, ?)`,
        )
        .bind(taprootMigrationNamespace, migration.id, checksum, appliedAt),
    ),
  ]);
}
