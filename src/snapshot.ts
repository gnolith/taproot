import type {
  SqliteDatabaseLike,
  SqlitePreparedStatementLike,
} from '@gnolith/diamond';
import {
  normalizeAuthorizationContext,
  SEARCH_ADMIN_CAPABILITY,
} from './authorization.js';
import {
  TAPROOT_JSON_VERSION,
  TAPROOT_RDF_VERSION,
  TAPROOT_SCHEMA_VERSION,
} from './schema.js';
import type { AuthorizationContext } from './types.js';

export interface TaprootInstallationSnapshotV1 {
  version: 1;
  installationId: string;
  createdAt: string;
  compatibility: {
    schema: string;
    canonicalJson: string;
    rdfMapping: string;
    searchProjection: 'taproot-unified-search-projection-v1';
  };
  /** Credentials are never persisted or exported. */
  credentialsIncluded: false;
  tables: Readonly<Record<string, readonly Record<string, unknown>[]>>;
}

export interface RestoreTaprootSnapshotOptionsV1 {
  discardIncompatibleDerived?: boolean;
}

const canonicalTables = [
  'taproot_entities',
  'taproot_entity_revisions',
  'taproot_audit_events',
  'rdf_quads',
  'taproot_rdf_ownership',
  'taproot_id_counters',
  'taproot_terms',
  'taproot_assertions',
  'taproot_installation_authorization',
  'taproot_installation_authorization_advances',
  'taproot_authorization_backfill_plans',
  'taproot_authorization_admin_audit',
  'taproot_entity_authorization',
  'taproot_entity_authorization_revisions',
  'taproot_statement_authorization',
  'taproot_statement_authorization_revisions',
  'taproot_resources',
  'taproot_annotations',
  'taproot_content_revisions',
  'taproot_content_audit',
] as const;

const derivedTables = [
  'taproot_authorization_projection_outbox',
  'taproot_unified_search_source_events',
  'taproot_unified_search_source_registry',
  'taproot_unified_search_producer_manifests',
  'taproot_unified_search_producer_adoptions',
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
  'taproot_search_admin_audit',
  'taproot_unified_search_producer_admin_audit',
  'taproot_semantic_configurations',
  'taproot_embedding_generations',
  'taproot_embedding_vectors',
  'taproot_embedding_plans',
  'taproot_embedding_work',
  'taproot_embedding_usage',
  'taproot_embedding_exclusions',
  'taproot_semantic_admin_audit',
] as const;

const allTables = [...canonicalTables, ...derivedTables] as const;
const tableSet = new Set<string>(allTables);

export async function createTaprootInstallationSnapshotV1(
  db: SqliteDatabaseLike,
  installationId: string,
  context: AuthorizationContext,
): Promise<TaprootInstallationSnapshotV1> {
  authorize(installationId, context);
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const table of allTables) {
    if (!(await exists(db, table))) continue;
    const result = await db
      .prepare(`SELECT * FROM ${table}`)
      .all<Record<string, unknown>>();
    tables[table] = result.results.map((row) => sanitizeRow(row));
  }
  return {
    version: 1,
    installationId,
    createdAt: new Date().toISOString(),
    compatibility: {
      schema: TAPROOT_SCHEMA_VERSION,
      canonicalJson: TAPROOT_JSON_VERSION,
      rdfMapping: TAPROOT_RDF_VERSION,
      searchProjection: 'taproot-unified-search-projection-v1',
    },
    credentialsIncluded: false,
    tables,
  };
}

/** Restore targets must be freshly migrated and contain no canonical records. */
export async function restoreTaprootInstallationSnapshotV1(
  db: SqliteDatabaseLike,
  snapshot: TaprootInstallationSnapshotV1,
  context: AuthorizationContext,
  options: RestoreTaprootSnapshotOptionsV1 = {},
): Promise<{ restoredTables: number; discardedDerived: boolean }> {
  authorize(snapshot.installationId, context);
  if (snapshot.version !== 1 || snapshot.credentialsIncluded !== false)
    throw new Error('snapshot format is invalid');
  if (
    snapshot.compatibility.canonicalJson !== TAPROOT_JSON_VERSION ||
    snapshot.compatibility.rdfMapping !== TAPROOT_RDF_VERSION
  )
    throw new Error('canonical snapshot compatibility mismatch');
  const derivedCompatible =
    snapshot.compatibility.schema === TAPROOT_SCHEMA_VERSION &&
    snapshot.compatibility.searchProjection ===
      'taproot-unified-search-projection-v1';
  if (!derivedCompatible && !options.discardIncompatibleDerived)
    throw new Error('derived snapshot compatibility mismatch');
  const entityCount = await db
    .prepare(`SELECT COUNT(*) AS count FROM taproot_entities`)
    .all<{ count: number }>();
  const resourceCount = await db
    .prepare(`SELECT COUNT(*) AS count FROM taproot_resources`)
    .all<{ count: number }>();
  if (
    Number(entityCount.results[0]?.count ?? 0) ||
    Number(resourceCount.results[0]?.count ?? 0)
  )
    throw new Error('snapshot restore requires an empty installation');
  const selected = derivedCompatible ? allTables : canonicalTables;
  const statements: SqlitePreparedStatementLike[] = [];
  let restoredTables = 0;
  for (const table of selected) {
    const rows = snapshot.tables[table];
    if (!rows?.length) continue;
    if (!tableSet.has(table)) throw new Error('snapshot table is unsupported');
    const columns = Object.keys(rows[0]!);
    if (
      !columns.length ||
      rows.some(
        (row) => JSON.stringify(Object.keys(row)) !== JSON.stringify(columns),
      )
    )
      throw new Error(`snapshot ${table} rows have inconsistent columns`);
    for (const row of rows)
      statements.push(
        db
          .prepare(
            `${table === 'taproot_id_counters' ? 'INSERT OR REPLACE' : 'INSERT'} INTO ${table}(${columns.map(quoteIdentifier).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
          )
          .bind(...columns.map((column) => row[column])),
      );
    restoredTables += 1;
  }
  if (statements.length) await db.batch(statements);
  return { restoredTables, discardedDerived: !derivedCompatible };
}

function authorize(
  installationId: string,
  rawContext: AuthorizationContext,
): void {
  const context = normalizeAuthorizationContext(rawContext);
  if (
    context.installationId !== installationId ||
    !context.capabilities.includes(SEARCH_ADMIN_CAPABILITY)
  )
    throw new Error('search:admin is required');
}

async function exists(db: SqliteDatabaseLike, table: string): Promise<boolean> {
  const result = await db
    .prepare(
      `SELECT 1 AS found FROM sqlite_schema WHERE type='table' AND name=?`,
    )
    .bind(table)
    .all<{ found: number }>();
  return result.results.length > 0;
}

function sanitizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (/secret|credential|api[_-]?key|authorization_header/iu.test(key))
      continue;
    result[key] = value;
  }
  return result;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value))
    throw new Error('snapshot column is invalid');
  return `"${value}"`;
}
