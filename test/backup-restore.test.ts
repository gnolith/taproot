import {
  createMigrationAssemblyAuthorityV1,
  createMigrationLedgerBackupV1,
  migrateDiamondStore,
  registerMigrationLedgerOwnerV1,
  type MigrationLedgerBackup,
  type MigrationLedgerOwnerHandle,
} from '@gnolith/diamond';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import {
  exportTaprootBackupSectionV1,
  importTaprootBackupSectionV1,
  registerTaprootMigrationLedgerOwnerHandleV1,
  type TaprootBackupSection,
  type TaprootMigrationLedgerOwnerHandleV1,
} from '../src/backup.js';
import { createTaprootHostWriteCapability } from '../src/index.js';
import {
  taprootMigrationNamespace,
  taprootMigrations,
} from '../src/migrations.js';
import { initializeTaproot } from '../src/schema.js';
import type { D1DatabaseLike } from '../src/sqlite-types.js';

const baseIri = 'https://backup.example';
const installationId = 'backup-installation';
const decoder = new TextDecoder();
const encoder = new TextEncoder();

for (const runtime of [nativeRuntime(), workerdRuntime()]) {
  describe(`Taproot owner backup restore on ${runtime.name}`, () => {
    it('imports a lexically reordered exact payload in dependency order and rolls back a late FK failure', async () => {
      const env = await runtime.open();
      try {
        await initializeTaproot(env.source, { baseIri });
        await seedCanonicalForeignKeys(env.source);
        const source = await registeredOwner(env.source, true);
        const section = await exportTaprootBackupSectionV1(
          env.source,
          installationId,
          source.handle,
        );

        const target = await registeredOwner(env.target, false);
        await target.backup.restoreNamespace(target.owner, section.ledger, {
          mode: 'empty',
        });
        const targetHandle = await bindOwner(env.target, target);
        await expect(
          importTaprootBackupSectionV1(env.target, section, targetHandle, {
            dryRun: true,
          }),
        ).resolves.toMatchObject({ dryRun: true });
        const imported = await importTaprootBackupSectionV1(
          env.target,
          section,
          targetHandle,
        );
        expect(imported.canonicalRows).toBeGreaterThan(0);
        await expect(
          count(env.target, 'taproot_authorization_grants'),
        ).resolves.toBe(1);
        await expect(count(env.target, 'taproot_audit_events')).resolves.toBe(
          1,
        );

        const rollback = await registeredOwner(env.rollback, false);
        await rollback.backup.restoreNamespace(rollback.owner, section.ledger, {
          mode: 'empty',
        });
        const rollbackHandle = await bindOwner(env.rollback, rollback);
        const corrupt = await rewriteCanonicalTables(section, (tables) => {
          const reversed = Object.fromEntries(Object.entries(tables).reverse());
          reversed.taproot_embedding_plans = [
            {
              plan_id: 'late-fk-failure',
              configuration_id: 'missing-configuration',
              generation: 1,
              state: 'estimated',
              estimate_json: '{}',
              policy_json: '{}',
              principal_id: 'principal-1',
              approved_by: null,
              created_at: '2026-07-23T00:00:00.000Z',
              approved_at: null,
              updated_at: '2026-07-23T00:00:00.000Z',
            },
          ];
          return reversed;
        });
        await expect(
          importTaprootBackupSectionV1(env.rollback, corrupt, rollbackHandle),
        ).rejects.toThrow();
        await expect(count(env.rollback, 'taproot_entities')).resolves.toBe(0);
        await expect(
          count(env.rollback, 'taproot_authorization_principals'),
        ).resolves.toBe(0);

        const missing = await rewriteCanonicalTables(section, (tables) => {
          delete tables.taproot_authorization_principals;
          return tables;
        });
        await expect(
          importTaprootBackupSectionV1(env.rollback, missing, rollbackHandle, {
            dryRun: true,
          }),
        ).rejects.toThrow(/table set/u);
        const extra = await rewriteCanonicalTables(section, (tables) => ({
          ...tables,
          foreign_owner_table: [],
        }));
        await expect(
          importTaprootBackupSectionV1(env.rollback, extra, rollbackHandle, {
            dryRun: true,
          }),
        ).rejects.toThrow();
      } finally {
        await env.close();
      }
    }, 120_000);
  });
}

async function seedCanonicalForeignKeys(db: D1DatabaseLike): Promise<void> {
  const now = '2026-07-23T00:00:00.000Z';
  const entity = JSON.stringify({
    id: 'Q1',
    type: 'item',
    labels: {},
    descriptions: {},
    aliases: {},
    claims: {},
    sitelinks: {},
    lastrevid: 1,
  });
  await db.batch([
    db
      .prepare(
        `INSERT INTO taproot_installation_authorization(
           singleton, installation_id, authorization_revision,
           search_generation, last_advance_id, created_at, updated_at
         ) VALUES (1, ?, 1, 1, 'bootstrap', ?, ?)`,
      )
      .bind(installationId, now, now),
    db
      .prepare(
        `INSERT INTO taproot_authorization_principals(
           installation_id, principal_id, created_at
         ) VALUES (?, 'principal-1', ?)`,
      )
      .bind(installationId, now),
    db
      .prepare(
        `INSERT INTO taproot_authorization_workspaces(
           installation_id, workspace_id, created_at
         ) VALUES (?, 'workspace-1', ?)`,
      )
      .bind(installationId, now),
    db
      .prepare(
        `INSERT INTO taproot_authorization_grants(
           installation_id, principal_id, workspace_id, capability,
           authorization_revision, created_at
         ) VALUES (?, 'principal-1', 'workspace-1', 'knowledge:write', 1, ?)`,
      )
      .bind(installationId, now),
    db
      .prepare(
        `INSERT INTO taproot_authorization_bootstraps(
           bootstrap_id, installation_id, principal_id, workspace_id,
           authorization_revision, input_sha256, grant_manifest_sha256,
           owner_registration_id, owner_receipt_sha256, idempotency_key,
           created_at
         ) VALUES (
           'bootstrap-1', ?, 'principal-1', 'workspace-1', 1,
           ?, ?, 'owner-1', ?, 'bootstrap-key', ?
         )`,
      )
      .bind(
        installationId,
        'a'.repeat(64),
        'b'.repeat(64),
        'c'.repeat(64),
        now,
      ),
    db
      .prepare(
        `INSERT INTO taproot_entities(
           entity_id, entity_type, datatype, revision, entity_json,
           created_at, modified_at
         ) VALUES ('Q1', 'item', NULL, 1, ?, ?, ?)`,
      )
      .bind(entity, now, now),
    db
      .prepare(
        `INSERT INTO taproot_entity_revisions(
           entity_id, revision, entity_json, actor, attribution_json,
           edit_summary, tags_json, event_id, content_hash, parent_hash,
           deleted_at, redirect_to, created_at
         ) VALUES (
           'Q1', 1, ?, NULL, NULL, NULL, '[]', 'event-1', ?, NULL,
           NULL, NULL, ?
         )`,
      )
      .bind(entity, 'd'.repeat(64), now),
    db
      .prepare(
        `INSERT INTO taproot_audit_events(
           event_id, entity_id, revision, event_type, attribution_json,
           edit_summary, tags_json, request_id, content_hash, parent_hash,
           details_json, created_at
         ) VALUES (
           'event-1', 'Q1', 1, 'create', NULL, NULL, '[]', NULL, ?,
           NULL, '{}', ?
         )`,
      )
      .bind('d'.repeat(64), now),
  ]);
}

async function registeredOwner(db: D1DatabaseLike, applied: boolean) {
  if (!applied) await migrateDiamondStore(db);
  const assembly = createMigrationAssemblyAuthorityV1(db, installationId);
  const owner = await registerMigrationLedgerOwnerV1({
    db,
    installationId,
    namespace: taprootMigrationNamespace,
    migrations: taprootMigrations,
    assemblyAuthority: assembly,
  });
  const backup = createMigrationLedgerBackupV1(db, assembly);
  const result: {
    owner: MigrationLedgerOwnerHandle;
    backup: MigrationLedgerBackup;
    handle: TaprootMigrationLedgerOwnerHandleV1;
  } = {
    owner,
    backup,
    handle: await bindOwner(db, { owner, backup }),
  };
  return result;
}

async function bindOwner(
  db: D1DatabaseLike,
  input: {
    owner: MigrationLedgerOwnerHandle;
    backup: MigrationLedgerBackup;
  },
): Promise<TaprootMigrationLedgerOwnerHandleV1> {
  const key = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const authority = createTaprootHostWriteCapability(db, { baseIri }, key);
  return registerTaprootMigrationLedgerOwnerHandleV1(
    db,
    { baseIri },
    authority,
    input.owner,
    input.backup,
  );
}

async function rewriteCanonicalTables(
  section: TaprootBackupSection,
  rewrite: (
    tables: Record<string, Array<Record<string, unknown>>>,
  ) => Record<string, Array<Record<string, unknown>>>,
): Promise<TaprootBackupSection> {
  const payload = JSON.parse(decoder.decode(section.canonicalPayload)) as {
    format: string;
    installationId: string;
    tables: Record<string, Array<Record<string, unknown>>>;
  };
  payload.tables = rewrite(structuredClone(payload.tables));
  const canonicalPayload = encoder.encode(JSON.stringify(payload));
  const manifest = {
    owner: 'taproot',
    formatVersion: 1,
    schemaVersion: section.schemaVersion,
    ledger: section.ledger,
    canonicalSha256: await sha256(canonicalPayload),
    derivedState: 'rebuildable',
  };
  return {
    ...section,
    canonicalPayload,
    sha256: await sha256(encoder.encode(canonicalJson(manifest))),
  };
}

async function count(db: D1DatabaseLike, table: string): Promise<number> {
  const result = await db
    .prepare(`SELECT COUNT(*) AS count FROM "${table}"`)
    .all<{ count: number }>();
  return Number(result.results[0]?.count ?? 0);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

async function sha256(value: Uint8Array): Promise<string> {
  const result = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new Uint8Array(value)),
  );
  return [...result].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface BackupEnvironment {
  source: D1DatabaseLike;
  target: D1DatabaseLike;
  rollback: D1DatabaseLike;
  close(): Promise<void>;
}

function nativeRuntime() {
  return {
    name: 'native SQLite',
    open(): Promise<BackupEnvironment> {
      const databases = [
        new NodeSqliteDatabase(':memory:'),
        new NodeSqliteDatabase(':memory:'),
        new NodeSqliteDatabase(':memory:'),
      ];
      return Promise.resolve({
        source: databases[0]!,
        target: databases[1]!,
        rollback: databases[2]!,
        close: () => Promise.all(databases.map((db) => db.close())).then(noop),
      });
    },
  };
}

function workerdRuntime() {
  return {
    name: 'real Workerd D1',
    async open(): Promise<BackupEnvironment> {
      const miniflare = new Miniflare({
        modules: true,
        script: `export default { fetch() { return new Response("ok"); } }`,
        d1Databases: {
          SOURCE: crypto.randomUUID(),
          TARGET: crypto.randomUUID(),
          ROLLBACK: crypto.randomUUID(),
        },
      });
      return {
        source: (await miniflare.getD1Database(
          'SOURCE',
        )) as unknown as D1DatabaseLike,
        target: (await miniflare.getD1Database(
          'TARGET',
        )) as unknown as D1DatabaseLike,
        rollback: (await miniflare.getD1Database(
          'ROLLBACK',
        )) as unknown as D1DatabaseLike,
        close: () => miniflare.dispose(),
      };
    },
  };
}

function noop(): void {}
