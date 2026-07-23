import type { D1DatabaseLike } from './sqlite-types.js';
import type { TaprootHostWriteCapability } from './assembly-authority.js';
import { assertTaprootHostWriteCapabilityInternal } from './assembly-authority.js';
import { InvalidAuthorizationError } from './errors.js';
import { taprootMigrationNamespace, taprootMigrations } from './migrations.js';
import type {
  MigrationLedgerBackup,
  MigrationLedgerOwnerHandle,
  MigrationLedgerSlice,
} from '@gnolith/diamond';
import { checksumMigration } from '@gnolith/diamond';

export type { MigrationLedgerSlice } from '@gnolith/diamond';

export interface TaprootBackupSection {
  owner: 'taproot';
  formatVersion: number;
  schemaVersion: string;
  ledger: MigrationLedgerSlice;
  canonicalPayload: Uint8Array;
  derivedPayload?: Uint8Array;
  legacySourceLedger?: MigrationLedgerSlice;
  legacyAdoptionSha256?: string;
  sha256: string;
}

export type TaprootMigrationLedgerOwnerHandleV1 = MigrationLedgerOwnerHandle;

export interface ResourceBlobDescriptor {
  referenceId: string;
  resourceId: string;
  revision: number;
  byteLength: number;
  sha256: string;
  mediaType: string;
}

export interface ResourceBlobBackupPort {
  enumerate(
    cursor: string | null,
    limit: number,
  ): Promise<{
    items: readonly ResourceBlobDescriptor[];
    cursor: string | null;
  }>;
  open(
    referenceId: string,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;
}

export interface ResourceBlobRestorePort {
  stage(
    descriptor: ResourceBlobDescriptor,
    stream: ReadableStream<Uint8Array>,
  ): Promise<string>;
  verify(stageId: string): Promise<void>;
  checkCollision(
    descriptor: ResourceBlobDescriptor,
  ): Promise<'absent' | 'identical' | 'conflict'>;
  rebind(stageId: string, canonicalReferenceId: string): Promise<void>;
  commit(stageIds: readonly string[]): Promise<void>;
  rollback(stageIds: readonly string[]): Promise<void>;
}

export interface ExportTaprootBackupSectionOptionsV1 {
  includeRebuildableDerived?: boolean;
}

export interface ImportTaprootBackupSectionOptionsV1 {
  dryRun?: boolean;
  importDerived?: boolean;
}

export interface LegacyTaproot042AttestationV1 {
  packageName: '@gnolith/taproot';
  packageVersion: '0.4.2';
}

export interface LegacyTaproot042AdoptionFragmentV1 {
  format: 'taproot-legacy-local-v1-owner-fragment-v1';
  sourcePackage: LegacyTaproot042AttestationV1;
  schemaVersion: '7';
  baseIri: string;
  installationId: string;
  canonicalDisposition: 'import';
  derivedDisposition: 'rebuild';
  canonicalPayload: Uint8Array;
  canonicalSha256: string;
  domainCounts: Readonly<{
    items: number;
    properties: number;
    statements: number;
    resources: number;
    annotations: number;
    revisions: number;
  }>;
  domainSha256: string;
  blobDescriptors: readonly ResourceBlobDescriptor[];
  ledger: MigrationLedgerSlice;
  sha256: string;
}

/**
 * Inspects an exact, read-only Taproot 0.4.2 owner database and emits a
 * bounded owner fragment. It never mutates the source or exposes table names.
 */
export async function inspectLegacyTaproot042ForAdoptionV1(
  source: D1DatabaseLike,
  attestation: LegacyTaproot042AttestationV1,
): Promise<LegacyTaproot042AdoptionFragmentV1> {
  if (
    attestation.packageName !== '@gnolith/taproot' ||
    attestation.packageVersion !== '0.4.2'
  )
    denied('exact Taproot 0.4.2 package attestation is required');
  const metadata = await source
    .prepare(
      `SELECT metadata_key, metadata_value FROM taproot_metadata
       WHERE metadata_key IN ('schema_version', 'base_iri')
       ORDER BY metadata_key`,
    )
    .all<{ metadata_key: string; metadata_value: string }>();
  const values = new Map(
    metadata.results.map(({ metadata_key, metadata_value }) => [
      metadata_key,
      metadata_value,
    ]),
  );
  if (values.get('schema_version') !== '7')
    denied('legacy Taproot schema is not exact version 7');
  const packageSeeds = await source
    .prepare(`SELECT version, name FROM taproot_migrations ORDER BY version`)
    .all<{ version: number; name: string }>();
  const expectedSeeds = [
    'initial',
    'audit-and-operations',
    'canonical-statement-text',
    'canonical-authorization-policy',
    'unified-search-source-events',
    'unified-search-materialization-lifecycle',
    'external-search-producers',
    'complete-search-content-semantic',
  ];
  if (
    packageSeeds.results.length !== expectedSeeds.length ||
    packageSeeds.results.some(
      ({ version, name }, index) =>
        version !== index + 1 || name !== expectedSeeds[index],
    )
  )
    denied('legacy Taproot package migration seeds are not exact');
  const resetObjects = await source
    .prepare(
      `SELECT COUNT(*) AS count FROM sqlite_schema
       WHERE name IN (
         'taproot_authorization_bootstraps',
         'taproot_external_search_kind_registrations',
         'taproot_content_authorization_revisions'
       )`,
    )
    .all<{ count: number }>();
  if (Number(resetObjects.results[0]?.count ?? 0) !== 0)
    denied('source is not an exact pre-reset Taproot database');
  const baseIri = identifier(values.get('base_iri'), 'baseIri', 2048);
  const installation = await source
    .prepare(
      `SELECT installation_id FROM taproot_installation_authorization
       WHERE singleton = 1`,
    )
    .all<{ installation_id: string }>();
  const installationId = identifier(
    installation.results[0]?.installation_id,
    'installationId',
    128,
  );
  const expected = await Promise.all(
    taprootMigrations.slice(0, 8).map(async (migration) => ({
      id: migration.id,
      checksum: await checksumMigration(migration),
    })),
  );
  const applied = await source
    .prepare(
      `SELECT migration_id, checksum, applied_at
       FROM _gnolith_migrations WHERE namespace = ?
       ORDER BY applied_at, migration_id`,
    )
    .bind(taprootMigrationNamespace)
    .all<{
      migration_id: string;
      checksum: string;
      applied_at: string;
    }>();
  if (
    applied.results.length !== expected.length ||
    applied.results.some(
      (entry, index) =>
        entry.migration_id !== expected[index]?.id ||
        entry.checksum !== expected[index]?.checksum,
    )
  )
    denied('legacy Taproot migration ledger is not exact 0.4.2 state');
  const ledgerEntries = applied.results.map((entry) => ({
    id: entry.migration_id,
    checksum: entry.checksum,
    appliedAt: entry.applied_at,
  }));
  const ledgerCanonical = encoder.encode(canonicalJson(ledgerEntries));
  const ledger: MigrationLedgerSlice = Object.freeze({
    format: 'diamond-migration-ledger-slice-v1',
    namespace: taprootMigrationNamespace,
    entries: Object.freeze(ledgerEntries),
    canonicalSha256: await sha256(ledgerCanonical),
  });
  const canonical = await exportTables(source, installationId, canonicalTables);
  const canonicalPayload = encoder.encode(canonicalJson(canonical));
  const canonicalSha256 = await sha256(canonicalPayload);
  const counts = await source
    .prepare(
      `SELECT
         SUM(CASE WHEN entity_type = 'item' THEN 1 ELSE 0 END) AS items,
         SUM(CASE WHEN entity_type = 'property' THEN 1 ELSE 0 END) AS properties,
         (SELECT COUNT(*) FROM taproot_entities e,
            json_each(e.entity_json, '$.claims') claim,
            json_each(claim.value)) AS statements,
         (SELECT COUNT(*) FROM taproot_resources WHERE installation_id = ?) AS resources,
         (SELECT COUNT(*) FROM taproot_annotations WHERE installation_id = ?) AS annotations,
         (SELECT COUNT(*) FROM taproot_entity_revisions) +
           (SELECT COUNT(*) FROM taproot_content_revisions) AS revisions
       FROM taproot_entities`,
    )
    .bind(installationId, installationId)
    .all<{
      items: number | null;
      properties: number | null;
      statements: number;
      resources: number;
      annotations: number;
      revisions: number;
    }>();
  const row = counts.results[0];
  const domainCounts = Object.freeze({
    items: Number(row?.items ?? 0),
    properties: Number(row?.properties ?? 0),
    statements: Number(row?.statements ?? 0),
    resources: Number(row?.resources ?? 0),
    annotations: Number(row?.annotations ?? 0),
    revisions: Number(row?.revisions ?? 0),
  });
  const blobDescriptors: ResourceBlobDescriptor[] = [];
  let cursor: string | null = null;
  do {
    const page = await enumerateResourceBlobDescriptorsV1(
      source,
      installationId,
      {
        cursor,
        limit: 1000,
      },
    );
    blobDescriptors.push(...page.items);
    if (blobDescriptors.length > 100_000)
      denied('legacy Taproot blob descriptor set exceeds its bound');
    cursor = page.cursor;
  } while (cursor !== null);
  const domainSha256 = await sha256(
    encoder.encode(canonicalJson(domainCounts)),
  );
  const manifest = {
    format: 'taproot-legacy-local-v1-owner-fragment-v1',
    sourcePackage: attestation,
    schemaVersion: '7',
    baseIri,
    installationId,
    canonicalDisposition: 'import',
    derivedDisposition: 'rebuild',
    canonicalSha256,
    domainCounts,
    domainSha256,
    blobDescriptors,
    ledger,
  } as const;
  const fragment: LegacyTaproot042AdoptionFragmentV1 = Object.freeze({
    ...manifest,
    canonicalPayload,
    blobDescriptors: Object.freeze(blobDescriptors),
    sha256: await sha256(encoder.encode(canonicalJson(manifest))),
  });
  legacyAdoptionFragments.add(fragment);
  return fragment;
}

interface LedgerHandleBinding {
  db: D1DatabaseLike;
  backup: MigrationLedgerBackup;
}

const ledgerHandleBindings = new WeakMap<object, LedgerHandleBinding>();
const legacyAdoptionFragments = new WeakSet<object>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_BLOB_BYTES = 1024 * 1024 * 1024;

/**
 * Converts only a live fragment issued by the exact 0.4.2 inspector into a
 * current owner section. Seedbed neither parses nor reconstructs the fragment.
 */
export async function convertLegacyTaproot042ToBackupSectionV1(
  target: D1DatabaseLike,
  fragment: LegacyTaproot042AdoptionFragmentV1,
  targetLedgerHandle: TaprootMigrationLedgerOwnerHandleV1,
): Promise<TaprootBackupSection> {
  if (!legacyAdoptionFragments.has(fragment))
    denied('live Taproot legacy adoption fragment is required');
  const binding = assertLedgerHandle(target, targetLedgerHandle);
  const ledger = await binding.backup.exportNamespace(targetLedgerHandle);
  const withoutHash = {
    owner: 'taproot',
    formatVersion: 1,
    schemaVersion: '9',
    ledger,
    legacySourceLedger: fragment.ledger,
    canonicalSha256: fragment.canonicalSha256,
    derivedState: 'rebuildable',
    legacyAdoptionSha256: fragment.sha256,
  };
  return Object.freeze({
    owner: 'taproot' as const,
    formatVersion: 1,
    schemaVersion: '9',
    ledger,
    legacySourceLedger: fragment.ledger,
    legacyAdoptionSha256: fragment.sha256,
    canonicalPayload: fragment.canonicalPayload,
    sha256: await sha256(encoder.encode(canonicalJson(withoutHash))),
  });
}

const canonicalTables = [
  'taproot_metadata',
  'taproot_migrations',
  'taproot_entities',
  'taproot_entity_revisions',
  'taproot_audit_events',
  'taproot_rdf_ownership',
  'taproot_id_counters',
  'taproot_terms',
  'taproot_installation_authorization',
  'taproot_installation_authorization_advances',
  'taproot_authorization_principals',
  'taproot_authorization_workspaces',
  'taproot_authorization_grants',
  'taproot_authorization_bootstraps',
  'taproot_entity_authorization',
  'taproot_entity_authorization_revisions',
  'taproot_statement_authorization',
  'taproot_statement_authorization_revisions',
  'taproot_resources',
  'taproot_annotations',
  'taproot_content_revisions',
  'taproot_content_audit',
  'taproot_unified_search_source_events',
  'taproot_unified_search_source_registry',
  'taproot_external_search_kind_registrations',
  'taproot_semantic_configurations',
  'taproot_embedding_plans',
  'taproot_embedding_usage',
  'taproot_embedding_exclusions',
] as const;

const rebuildableDerivedTables = [
  'rdf_quads',
  'taproot_authorization_projection_outbox',
  'taproot_search_corpora',
  'taproot_search_installation_state',
  'taproot_unified_search_generation_producers',
  'taproot_search_kind_checkpoints',
  'taproot_search_projection_jobs',
  'taproot_search_job_transitions',
  'taproot_search_stages',
  'taproot_search_stage_pages',
  'taproot_search_staged_documents',
  'taproot_search_document_clauses',
  'taproot_search_document_atoms',
  'taproot_search_filter_values',
  'taproot_search_chunks',
  'taproot_search_materialization_heads',
  'taproot_search_materialization_tombstones',
  'taproot_search_rebuild_roots',
  'taproot_embedding_generations',
  'taproot_embedding_vectors',
  'taproot_embedding_work',
] as const;

export function registerTaprootMigrationLedgerOwnerHandleV1(
  db: D1DatabaseLike,
  options: { baseIri: string },
  authority: TaprootHostWriteCapability,
  liveDiamondOwnerHandle: MigrationLedgerOwnerHandle,
  ledgerBackup: MigrationLedgerBackup,
): TaprootMigrationLedgerOwnerHandleV1 {
  assertTaprootHostWriteCapabilityInternal(db, options, authority);
  if (
    !liveDiamondOwnerHandle ||
    typeof liveDiamondOwnerHandle !== 'object' ||
    liveDiamondOwnerHandle.namespace !== taprootMigrationNamespace ||
    !ledgerBackup ||
    typeof ledgerBackup.exportNamespace !== 'function' ||
    typeof ledgerBackup.validateNamespace !== 'function'
  )
    denied('live Diamond migration-ledger owner handle is required');
  ledgerHandleBindings.set(liveDiamondOwnerHandle, {
    db,
    backup: ledgerBackup,
  });
  return liveDiamondOwnerHandle;
}

export async function exportTaprootBackupSectionV1(
  db: D1DatabaseLike,
  installationId: string,
  ledgerHandle: TaprootMigrationLedgerOwnerHandleV1,
  options: ExportTaprootBackupSectionOptionsV1 = {},
): Promise<TaprootBackupSection> {
  const canonical = await exportTables(db, installationId, canonicalTables);
  const canonicalPayload = encoder.encode(canonicalJson(canonical));
  const binding = assertLedgerHandle(db, ledgerHandle);
  const ledger = await binding.backup.exportNamespace(ledgerHandle);
  const schemaMetadata = (
    canonical.tables.taproot_metadata as
      Array<{ metadata_key?: unknown; metadata_value?: unknown }> | undefined
  )?.find(
    ({ metadata_key }) => metadata_key === 'schema_version',
  )?.metadata_value;
  const schemaVersion =
    typeof schemaMetadata === 'string' ? schemaMetadata : '';
  const derivedPayload = options.includeRebuildableDerived
    ? encoder.encode(
        canonicalJson(
          await exportTables(db, installationId, rebuildableDerivedTables),
        ),
      )
    : undefined;
  const withoutHash = {
    owner: 'taproot',
    formatVersion: 1,
    schemaVersion,
    ledger,
    canonicalSha256: await sha256(canonicalPayload),
    ...(derivedPayload
      ? { derivedSha256: await sha256(derivedPayload) }
      : { derivedState: 'rebuildable' }),
  };
  return {
    owner: 'taproot',
    formatVersion: 1,
    schemaVersion,
    ledger,
    canonicalPayload,
    ...(derivedPayload ? { derivedPayload } : {}),
    sha256: await sha256(encoder.encode(canonicalJson(withoutHash))),
  };
}

export async function importTaprootBackupSectionV1(
  db: D1DatabaseLike,
  section: TaprootBackupSection,
  ledgerHandle: TaprootMigrationLedgerOwnerHandleV1,
  options: ImportTaprootBackupSectionOptionsV1 = {},
): Promise<{
  canonicalRows: number;
  derivedRows: number;
  dryRun: boolean;
}> {
  const binding = assertLedgerHandle(db, ledgerHandle);
  if (
    section.owner !== 'taproot' ||
    section.formatVersion !== 1 ||
    section.ledger.namespace !== taprootMigrationNamespace
  )
    denied('Taproot backup section is invalid');
  const canonicalSha256 = await sha256(section.canonicalPayload);
  const derivedSha256 = section.derivedPayload
    ? await sha256(section.derivedPayload)
    : undefined;
  const checksumManifest = {
    owner: 'taproot',
    formatVersion: 1,
    schemaVersion: section.schemaVersion,
    ledger: section.ledger,
    ...(section.legacySourceLedger
      ? {
          legacySourceLedger: section.legacySourceLedger,
          canonicalSha256,
          derivedState: 'rebuildable',
          legacyAdoptionSha256: digest(
            section.legacyAdoptionSha256,
            'legacyAdoptionSha256',
          ),
        }
      : {
          canonicalSha256,
          ...(derivedSha256
            ? { derivedSha256 }
            : { derivedState: 'rebuildable' }),
        }),
  };
  if (
    section.sha256 !==
    (await sha256(encoder.encode(canonicalJson(checksumManifest))))
  )
    denied('Taproot backup section checksum is invalid');
  const canonical = parsePayload(section.canonicalPayload);
  const installationId = identifier(
    canonical.installationId,
    'installationId',
    128,
  );
  const derived =
    options.importDerived && section.derivedPayload
      ? parsePayload(section.derivedPayload)
      : null;
  await binding.backup.validateNamespace(ledgerHandle, section.ledger);
  const canonicalRows = validateImportTables(
    canonical.tables,
    new Set(canonicalTables),
    installationId,
  );
  const derivedRows = derived
    ? validateImportTables(
        derived.tables,
        new Set(rebuildableDerivedTables),
        installationId,
      )
    : 0;
  await assertEmptyImportTarget(db);
  if (!options.dryRun) {
    await importTables(db, canonical.tables);
    if (derived) await importTables(db, derived.tables);
  }
  return {
    canonicalRows,
    derivedRows,
    dryRun: options.dryRun === true,
  };
}

export async function enumerateResourceBlobDescriptorsV1(
  db: D1DatabaseLike,
  installationId: string,
  input: { cursor?: string | null; limit: number },
): Promise<{ items: ResourceBlobDescriptor[]; cursor: string | null }> {
  const limit = integer(input.limit, 'limit', 1, 1000);
  const cursor =
    input.cursor == null ? '' : identifier(input.cursor, 'cursor', 256);
  const rows = await db
    .prepare(
      `SELECT record_id, revision, record_json
       FROM taproot_resources
       WHERE installation_id = ? AND record_id > ? AND deleted_at IS NULL
       ORDER BY record_id LIMIT ?`,
    )
    .bind(installationId, cursor, limit)
    .all<{ record_id: string; revision: number; record_json: string }>();
  const items: ResourceBlobDescriptor[] = [];
  for (const row of rows.results) {
    const record = JSON.parse(row.record_json) as {
      payload?: {
        kind?: unknown;
        referenceId?: unknown;
        location?: unknown;
        storage?: unknown;
      };
      integrity?: { byteLength?: unknown; digest?: unknown };
      mediaType?: unknown;
    };
    const referenceId =
      record.payload?.kind === 'blob-reference'
        ? record.payload.referenceId
        : record.payload?.kind === 'location' &&
            record.payload.storage !== 'url'
          ? record.payload.location
          : undefined;
    if (referenceId === undefined) continue;
    items.push({
      referenceId: identifier(referenceId, 'referenceId', 512),
      resourceId: row.record_id,
      revision: Number(row.revision),
      byteLength: integer(
        record.integrity?.byteLength,
        'byteLength',
        0,
        MAX_BLOB_BYTES,
      ),
      sha256: digest(record.integrity?.digest, 'sha256'),
      mediaType: identifier(record.mediaType, 'mediaType', 256),
    });
  }
  return {
    items,
    cursor:
      rows.results.length === limit ? rows.results.at(-1)!.record_id : null,
  };
}

export async function openVerifiedResourceBlobV1(
  db: D1DatabaseLike,
  installationId: string,
  port: ResourceBlobBackupPort,
  descriptor: ResourceBlobDescriptor,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  await assertCanonicalBlobDescriptor(db, installationId, descriptor);
  const stream = await port.open(descriptor.referenceId, signal);
  return verifiedStream(stream, descriptor, signal);
}

export async function restoreResourceBlobsV1(
  db: D1DatabaseLike,
  installationId: string,
  descriptors: readonly ResourceBlobDescriptor[],
  streams: (
    descriptor: ResourceBlobDescriptor,
  ) => Promise<ReadableStream<Uint8Array>>,
  port: ResourceBlobRestorePort,
): Promise<{ staged: number; identical: number }> {
  if (descriptors.length > 10_000)
    denied('resource blob restore batch is too large');
  const stageIds: string[] = [];
  let identical = 0;
  try {
    for (const raw of descriptors) {
      const descriptor = normalizeDescriptor(raw);
      await assertCanonicalBlobDescriptor(db, installationId, descriptor);
      const collision = await port.checkCollision(descriptor);
      if (collision === 'conflict')
        denied('resource blob collision conflicts with canonical content');
      if (collision === 'identical') {
        identical += 1;
        continue;
      }
      if (collision !== 'absent')
        denied('resource blob collision response is invalid');
      const stageId = identifier(
        await port.stage(
          descriptor,
          verifiedStream(await streams(descriptor), descriptor),
        ),
        'stageId',
        256,
      );
      stageIds.push(stageId);
      await port.verify(stageId);
      await assertCanonicalBlobDescriptor(db, installationId, descriptor);
      await port.rebind(stageId, descriptor.referenceId);
    }
    if (stageIds.length) await port.commit(Object.freeze([...stageIds]));
    return { staged: stageIds.length, identical };
  } catch (cause) {
    if (stageIds.length) await port.rollback(Object.freeze([...stageIds]));
    throw cause;
  }
}

function verifiedStream(
  source: ReadableStream<Uint8Array>,
  descriptor: ResourceBlobDescriptor,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const normalized = normalizeDescriptor(descriptor);
  const hasher = new Sha256();
  let count = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (signal?.aborted)
          throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        if (!(chunk instanceof Uint8Array))
          denied('resource blob stream emitted a non-byte chunk');
        count += chunk.byteLength;
        if (count > normalized.byteLength || count > MAX_BLOB_BYTES)
          denied('resource blob stream exceeds its declared bound');
        hasher.update(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        if (
          count !== normalized.byteLength ||
          hasher.digestHex() !== normalized.sha256
        )
          denied('resource blob stream size or digest does not match');
      },
    }),
  );
}

async function assertCanonicalBlobDescriptor(
  db: D1DatabaseLike,
  installationId: string,
  descriptor: ResourceBlobDescriptor,
): Promise<void> {
  const normalized = normalizeDescriptor(descriptor);
  const result = await db
    .prepare(
      `SELECT revision, record_json FROM taproot_resources
       WHERE installation_id = ? AND record_id = ? AND deleted_at IS NULL`,
    )
    .bind(installationId, normalized.resourceId)
    .all<{ revision: number; record_json: string }>();
  const row = result.results[0];
  if (!row || Number(row.revision) !== normalized.revision)
    denied('resource blob descriptor has no canonical owner');
  const record = JSON.parse(row.record_json) as {
    payload?: { referenceId?: unknown; location?: unknown };
    integrity?: { byteLength?: unknown; digest?: unknown };
    mediaType?: unknown;
  };
  if (
    (record.payload?.referenceId ?? record.payload?.location) !==
      normalized.referenceId ||
    Number(record.integrity?.byteLength) !== normalized.byteLength ||
    record.integrity?.digest !== normalized.sha256 ||
    record.mediaType !== normalized.mediaType
  )
    denied('resource blob descriptor does not match canonical state');
}

async function exportTables(
  db: D1DatabaseLike,
  installationId: string,
  tables: readonly string[],
) {
  const output: Record<string, readonly Record<string, unknown>[]> = {};
  for (const table of tables) {
    if (!(await tableExists(db, table))) continue;
    const rows = await db
      .prepare(`SELECT * FROM "${table}"`)
      .all<Record<string, unknown>>();
    output[table] = rows.results
      .filter((row) => belongsToInstallation(row, installationId))
      .map(sanitizeRow);
  }
  return { format: 'taproot-owner-payload-v1', installationId, tables: output };
}

function belongsToInstallation(
  row: Record<string, unknown>,
  installationId: string,
): boolean {
  return !('installation_id' in row) || row.installation_id === installationId;
}

function sanitizeRow(row: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (/credential|secret|api[_-]?key|authorization_header/iu.test(key))
      continue;
    result[key] = value;
  }
  return result;
}

function parsePayload(payload: Uint8Array): {
  format: string;
  installationId: string;
  tables: Record<string, Array<Record<string, unknown>>>;
} {
  const parsed = JSON.parse(decoder.decode(payload)) as {
    format?: unknown;
    installationId?: unknown;
    tables?: unknown;
  };
  if (
    parsed.format !== 'taproot-owner-payload-v1' ||
    typeof parsed.installationId !== 'string' ||
    !parsed.tables ||
    typeof parsed.tables !== 'object' ||
    Array.isArray(parsed.tables)
  )
    denied('Taproot backup payload is invalid');
  return parsed as {
    format: string;
    installationId: string;
    tables: Record<string, Array<Record<string, unknown>>>;
  };
}

function validateImportTables(
  tables: Record<string, Array<Record<string, unknown>>>,
  allowed: Set<string>,
  installationId: string,
): number {
  let rows = 0;
  for (const [table, values] of Object.entries(tables)) {
    if (!allowed.has(table) || !Array.isArray(values))
      denied('Taproot backup contains a foreign table');
    for (const row of values) {
      if (
        !row ||
        typeof row !== 'object' ||
        !belongsToInstallation(row, installationId)
      )
        denied('Taproot backup contains cross-installation state');
      rows += 1;
    }
  }
  return rows;
}

async function importTables(
  db: D1DatabaseLike,
  tables: Record<string, Array<Record<string, unknown>>>,
): Promise<void> {
  const statements = [];
  for (const [table, rows] of Object.entries(tables)) {
    for (const row of rows) {
      const columns = Object.keys(row);
      if (!columns.length) continue;
      statements.push(
        db
          .prepare(
            `INSERT INTO "${table}"(${columns
              .map((column) => `"${safeColumn(column)}"`)
              .join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
          )
          .bind(...columns.map((column) => row[column])),
      );
    }
  }
  if (statements.length) await db.batch(statements);
}

async function assertEmptyImportTarget(db: D1DatabaseLike): Promise<void> {
  for (const table of [
    'taproot_entities',
    'taproot_resources',
    'taproot_annotations',
  ]) {
    if (!(await tableExists(db, table))) continue;
    const result = await db
      .prepare(`SELECT COUNT(*) AS count FROM "${table}"`)
      .all<{ count: number }>();
    if (Number(result.results[0]?.count ?? 0) !== 0)
      denied('Taproot backup import requires an empty owner schema');
  }
}

function assertLedgerHandle(
  db: D1DatabaseLike,
  handle: TaprootMigrationLedgerOwnerHandleV1,
): LedgerHandleBinding {
  const binding = ledgerHandleBindings.get(handle);
  if (binding?.db !== db)
    denied('Taproot migration-ledger owner handle is invalid');
  return binding;
}

async function tableExists(
  db: D1DatabaseLike,
  table: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `SELECT 1 AS found FROM sqlite_schema WHERE type='table' AND name=?`,
    )
    .bind(table)
    .all<{ found: number }>();
  return result.results.length > 0;
}

function normalizeDescriptor(
  raw: ResourceBlobDescriptor,
): ResourceBlobDescriptor {
  return Object.freeze({
    referenceId: identifier(raw.referenceId, 'referenceId', 512),
    resourceId: identifier(raw.resourceId, 'resourceId', 256),
    revision: integer(raw.revision, 'revision', 1, Number.MAX_SAFE_INTEGER),
    byteLength: integer(raw.byteLength, 'byteLength', 0, MAX_BLOB_BYTES),
    sha256: digest(raw.sha256, 'sha256'),
    mediaType: identifier(raw.mediaType, 'mediaType', 256),
  });
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

function safeColumn(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value))
    denied('Taproot backup column is invalid');
  return value;
}

function identifier(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    denied(`${field} is invalid`);
  return value;
}

function digest(value: unknown, field: string): string {
  const normalized = identifier(value, field, 64);
  if (!/^[0-9a-f]{64}$/u.test(normalized)) denied(`${field} is invalid`);
  return normalized;
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    denied(`${field} is invalid`);
  return value;
}

function denied(message: string): never {
  throw new InvalidAuthorizationError(message);
}

/** Small portable incremental SHA-256 used to verify streams without buffering. */
class Sha256 {
  readonly #state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  #buffer = new Uint8Array(64);
  #bufferLength = 0;
  #bytes = 0;

  update(input: Uint8Array): void {
    this.#bytes += input.length;
    let offset = 0;
    while (offset < input.length) {
      const take = Math.min(64 - this.#bufferLength, input.length - offset);
      this.#buffer.set(
        input.subarray(offset, offset + take),
        this.#bufferLength,
      );
      this.#bufferLength += take;
      offset += take;
      if (this.#bufferLength === 64) {
        this.#compress(this.#buffer);
        this.#bufferLength = 0;
      }
    }
  }

  digestHex(): string {
    const bitLength = this.#bytes * 8;
    this.#buffer[this.#bufferLength++] = 0x80;
    if (this.#bufferLength > 56) {
      this.#buffer.fill(0, this.#bufferLength);
      this.#compress(this.#buffer);
      this.#bufferLength = 0;
    }
    this.#buffer.fill(0, this.#bufferLength, 56);
    const high = Math.floor(bitLength / 0x1_0000_0000);
    const low = bitLength >>> 0;
    const view = new DataView(this.#buffer.buffer);
    view.setUint32(56, high, false);
    view.setUint32(60, low, false);
    this.#compress(this.#buffer);
    return [...this.#state]
      .map((word) => word.toString(16).padStart(8, '0'))
      .join('');
  }

  #compress(block: Uint8Array): void {
    const k = SHA256_K;
    const w = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1)
      w[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const x = w[index - 15]!;
      const y = w[index - 2]!;
      const s0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
      const s1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
      w[index] = (w[index - 16]! + s0 + w[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.#state;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotate(e!, 6) ^ rotate(e!, 11) ^ rotate(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const t1 = (h! + s1 + choice + k[index]! + w[index]!) >>> 0;
      const s0 = rotate(a!, 2) ^ rotate(a!, 13) ^ rotate(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < 8; index += 1)
      this.#state[index] = (this.#state[index]! + next[index]!) >>> 0;
  }
}

function rotate(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
