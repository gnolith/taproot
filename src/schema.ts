import { initializeStore, type D1DatabaseLike } from '@gnolith/diamond';
import { SchemaMismatchError } from './errors.js';

export const TAPROOT_SCHEMA_VERSION = '1';
export const TAPROOT_JSON_VERSION = '1';
export const TAPROOT_RDF_VERSION = '1';

export const taprootSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS taproot_entities (
    entity_id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('item', 'property')),
    datatype TEXT,
    revision INTEGER NOT NULL,
    entity_json TEXT NOT NULL CHECK (json_valid(entity_json)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    modified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT,
    redirect_to TEXT,
    CHECK ((entity_type = 'item' AND datatype IS NULL)
      OR (entity_type = 'property' AND datatype IS NOT NULL))
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_entity_revisions (
    entity_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    entity_json TEXT NOT NULL CHECK (json_valid(entity_json)),
    actor TEXT,
    edit_summary TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (entity_id, revision),
    FOREIGN KEY (entity_id) REFERENCES taproot_entities(entity_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_id_counters (
    entity_type TEXT PRIMARY KEY CHECK (entity_type IN ('item', 'property')),
    next_numeric_id INTEGER NOT NULL CHECK (next_numeric_id > 0)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_terms (
    entity_id TEXT NOT NULL,
    language TEXT NOT NULL,
    term_type TEXT NOT NULL CHECK (term_type IN ('label', 'description', 'alias')),
    value TEXT NOT NULL,
    ordinal INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (entity_id, language, term_type, ordinal),
    FOREIGN KEY (entity_id) REFERENCES taproot_entities(entity_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_metadata (
    metadata_key TEXT PRIMARY KEY,
    metadata_value TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_assertions (
    assertion_key TEXT PRIMARY KEY
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS taproot_entities_type_idx
    ON taproot_entities(entity_type, entity_id)`,
  `CREATE INDEX IF NOT EXISTS taproot_entities_modified_idx
    ON taproot_entities(modified_at, entity_id)`,
  `CREATE INDEX IF NOT EXISTS taproot_revisions_entity_idx
    ON taproot_entity_revisions(entity_id, revision DESC)`,
  `CREATE INDEX IF NOT EXISTS taproot_terms_lookup_idx
    ON taproot_terms(language, value COLLATE NOCASE, entity_id)`,
  `INSERT INTO taproot_id_counters(entity_type, next_numeric_id)
    VALUES ('item', 1), ('property', 1)
    ON CONFLICT(entity_type) DO NOTHING`,
  `INSERT INTO taproot_metadata(metadata_key, metadata_value)
    VALUES
      ('schema_version', '${TAPROOT_SCHEMA_VERSION}'),
      ('canonical_json_version', '${TAPROOT_JSON_VERSION}'),
      ('rdf_mapping_version', '${TAPROOT_RDF_VERSION}')
    ON CONFLICT(metadata_key) DO NOTHING`,
] as const;

export interface TaprootSchemaInspection {
  valid: boolean;
  versions: Record<string, string>;
  missingTables: string[];
  errors: string[];
}

export async function initializeTaproot(db: D1DatabaseLike): Promise<void> {
  await initializeStore(db);
  await db.batch(taprootSchemaStatements.map((sql) => db.prepare(sql)));
}

export async function inspectTaprootSchema(
  db: D1DatabaseLike,
): Promise<TaprootSchemaInspection> {
  const required = [
    'taproot_entities',
    'taproot_entity_revisions',
    'taproot_id_counters',
    'taproot_terms',
    'taproot_metadata',
    'taproot_assertions',
  ];
  const tables = await db
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name LIKE 'taproot_%'`,
    )
    .all<{ name: string }>();
  const names = new Set(tables.results.map(({ name }) => name));
  const missingTables = required.filter((name) => !names.has(name));
  const metadata = names.has('taproot_metadata')
    ? await db
        .prepare('SELECT metadata_key, metadata_value FROM taproot_metadata')
        .all<{ metadata_key: string; metadata_value: string }>()
    : { results: [] };
  const versions = Object.fromEntries(
    metadata.results.map(({ metadata_key, metadata_value }) => [
      metadata_key,
      metadata_value,
    ]),
  );
  const expected = {
    schema_version: TAPROOT_SCHEMA_VERSION,
    canonical_json_version: TAPROOT_JSON_VERSION,
    rdf_mapping_version: TAPROOT_RDF_VERSION,
  };
  const errors = missingTables.map((name) => `${name} is missing`);
  for (const [key, value] of Object.entries(expected)) {
    if (versions[key] !== value) {
      errors.push(`${key} is ${versions[key] ?? 'missing'}, expected ${value}`);
    }
  }
  return { valid: errors.length === 0, versions, missingTables, errors };
}

export async function assertTaprootSchema(db: D1DatabaseLike): Promise<void> {
  const inspection = await inspectTaprootSchema(db);
  if (!inspection.valid) {
    throw new SchemaMismatchError(inspection.errors.join('; '));
  }
}
