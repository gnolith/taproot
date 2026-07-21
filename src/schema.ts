import {
  encodeTerm,
  migrateDiamondStore,
  prepareQuadPatch,
  type SqliteDatabaseLike,
} from '@gnolith/diamond';
import { DataFactory } from 'rdf-data-factory';
import { parseEntityJson } from './canonical.js';
import { buildEntityQuads } from './rdf.js';
import type { EntityId, WikibaseEntity } from './types.js';
import { BaseIriMismatchError, SchemaMismatchError } from './errors.js';

export const TAPROOT_SCHEMA_VERSION = '2';
export const TAPROOT_JSON_VERSION = '1';
export const TAPROOT_RDF_VERSION = '2';

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
    attribution_json TEXT CHECK (attribution_json IS NULL OR json_valid(attribution_json)),
    edit_summary TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
    event_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    parent_hash TEXT,
    deleted_at TEXT,
    redirect_to TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (entity_id, revision),
    FOREIGN KEY (entity_id) REFERENCES taproot_entities(entity_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_audit_events (
    event_id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('create', 'update', 'revert', 'delete', 'restore', 'redirect', 'import', 'repair')),
    attribution_json TEXT CHECK (attribution_json IS NULL OR json_valid(attribution_json)),
    edit_summary TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
    request_id TEXT,
    content_hash TEXT NOT NULL,
    parent_hash TEXT,
    details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
    created_at TEXT NOT NULL,
    FOREIGN KEY (entity_id, revision) REFERENCES taproot_entity_revisions(entity_id, revision)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_rdf_ownership (
    entity_id TEXT NOT NULL,
    subject_key TEXT NOT NULL,
    predicate_key TEXT NOT NULL,
    object_key TEXT NOT NULL,
    graph_key TEXT NOT NULL,
    PRIMARY KEY (entity_id, subject_key, predicate_key, object_key, graph_key),
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
  `CREATE INDEX IF NOT EXISTS taproot_audit_entity_idx
    ON taproot_audit_events(entity_id, revision DESC, event_id)`,
  `CREATE INDEX IF NOT EXISTS taproot_audit_request_idx
    ON taproot_audit_events(request_id) WHERE request_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS taproot_rdf_ownership_quad_idx
    ON taproot_rdf_ownership(subject_key, predicate_key, object_key, graph_key, entity_id)`,
  `CREATE TRIGGER IF NOT EXISTS taproot_revisions_no_update
    BEFORE UPDATE ON taproot_entity_revisions BEGIN SELECT RAISE(ABORT, 'taproot revisions are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_revisions_no_delete
    BEFORE DELETE ON taproot_entity_revisions BEGIN SELECT RAISE(ABORT, 'taproot revisions are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_audit_no_update
    BEFORE UPDATE ON taproot_audit_events BEGIN SELECT RAISE(ABORT, 'taproot audit events are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_audit_no_delete
    BEFORE DELETE ON taproot_audit_events BEGIN SELECT RAISE(ABORT, 'taproot audit events are immutable'); END`,
  `INSERT INTO taproot_id_counters(entity_type, next_numeric_id)
    VALUES ('item', 1), ('property', 1)
    ON CONFLICT(entity_type) DO NOTHING`,
  `INSERT INTO taproot_metadata(metadata_key, metadata_value)
    VALUES
      ('schema_version', '${TAPROOT_SCHEMA_VERSION}'),
      ('canonical_json_version', '${TAPROOT_JSON_VERSION}'),
      ('rdf_mapping_version', '${TAPROOT_RDF_VERSION}')
    ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value`,
  `INSERT INTO taproot_migrations(version, name) VALUES (1, 'initial'), (2, 'audit-and-operations')
    ON CONFLICT(version) DO NOTHING`,
] as const;

const schemaStatement = (prefix: string): string => {
  const statement = taprootSchemaStatements.find((sql) =>
    sql.trimStart().startsWith(prefix),
  );
  if (!statement)
    throw new Error(`Missing Taproot schema statement: ${prefix}`);
  return statement;
};

/** Exact package-created schema used before the v2 audit migration. */
export const legacyTaprootV1Statements = [
  schemaStatement('CREATE TABLE IF NOT EXISTS taproot_entities'),
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
  schemaStatement('CREATE TABLE IF NOT EXISTS taproot_id_counters'),
  schemaStatement('CREATE TABLE IF NOT EXISTS taproot_terms'),
  schemaStatement('CREATE TABLE IF NOT EXISTS taproot_metadata'),
  schemaStatement('CREATE TABLE IF NOT EXISTS taproot_assertions'),
  schemaStatement('CREATE INDEX IF NOT EXISTS taproot_entities_type_idx'),
  schemaStatement('CREATE INDEX IF NOT EXISTS taproot_entities_modified_idx'),
  schemaStatement('CREATE INDEX IF NOT EXISTS taproot_revisions_entity_idx'),
  schemaStatement('CREATE INDEX IF NOT EXISTS taproot_terms_lookup_idx'),
  `INSERT INTO taproot_id_counters(entity_type, next_numeric_id)
   VALUES ('item', 1), ('property', 1)`,
  `INSERT INTO taproot_metadata(metadata_key, metadata_value)
   VALUES
     ('schema_version', '1'),
     ('canonical_json_version', '1'),
     ('rdf_mapping_version', '1')`,
] as const;

export interface TaprootSchemaInspection {
  valid: boolean;
  versions: Record<string, string>;
  missingTables: string[];
  nonStrictTables: string[];
  missingColumns: string[];
  missingIndexes: string[];
  missingTriggers: string[];
  errors: string[];
}

export async function initializeTaproot(
  db: SqliteDatabaseLike,
  options: { baseIri?: string } = {},
): Promise<void> {
  const previousRdfVersion =
    (await readMetadata(db, 'rdf_migration_from')) ??
    (await readMetadata(db, 'rdf_mapping_version'));
  const initialInspection = await inspectTaprootSchema(db);
  const existingTables = await db
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name LIKE 'taproot_%' ORDER BY name`,
    )
    .all<{ name: string }>();
  if (existingTables.results.length > 0 && !initialInspection.valid) {
    const { canonicalizeTaprootBaseIri } = await import('./migrations.js');
    const storedIdentity = await readMetadata(db, 'base_iri');
    const requestedIdentity = options.baseIri ?? storedIdentity;
    if (requestedIdentity === undefined) {
      throw new SchemaMismatchError(
        'baseIri is required to adopt a legacy Taproot database',
      );
    }
    const canonicalIdentity = canonicalizeTaprootBaseIri(requestedIdentity);
    if (
      storedIdentity !== undefined &&
      canonicalizeTaprootBaseIri(storedIdentity) !== canonicalIdentity
    ) {
      throw new BaseIriMismatchError(
        `Taproot database identity is ${storedIdentity}, not ${requestedIdentity}`,
      );
    }
    if (!(await isRecognizedLegacyV1(db, existingTables.results))) {
      throw new SchemaMismatchError(
        `Existing Taproot schema is not the exact supported version-one layout: ${initialInspection.errors.join('; ')}`,
      );
    }
    await migrateDiamondStore(db);
    await upgradeLegacySchema(db);
    await db.batch(taprootSchemaStatements.map((sql) => db.prepare(sql)));
    const { checksumMigration } = await import('@gnolith/diamond');
    const { taprootMigrationNamespace, taprootMigrations } =
      await import('./migrations.js');
    const checksum = await checksumMigration(taprootMigrations[0]);
    await db.batch([
      db
        .prepare(
          `INSERT INTO taproot_metadata(metadata_key, metadata_value)
           VALUES ('base_iri', ?)
           ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value`,
        )
        .bind(canonicalIdentity),
      db
        .prepare(
          `INSERT INTO taproot_assertions(assertion_key)
           SELECT NULL WHERE NOT EXISTS (
             SELECT 1 FROM taproot_metadata
             WHERE metadata_key = 'base_iri' AND metadata_value = ?
           )`,
        )
        .bind(canonicalIdentity),
      db
        .prepare(
          `INSERT INTO _gnolith_migrations
           (namespace, migration_id, checksum, adopted, applied_at)
           VALUES (?, ?, ?, 1, ?)`,
        )
        .bind(
          taprootMigrationNamespace,
          taprootMigrations[0].id,
          checksum,
          new Date().toISOString(),
        ),
    ]);
  }
  if (previousRdfVersion && previousRdfVersion !== TAPROOT_RDF_VERSION) {
    await db
      .prepare(
        `INSERT INTO taproot_metadata(metadata_key, metadata_value) VALUES ('rdf_migration_from', ?)
      ON CONFLICT(metadata_key) DO NOTHING`,
      )
      .bind(previousRdfVersion)
      .run();
  }
  const { applyTaprootMigrations } = await import('./migrations.js');
  await applyTaprootMigrations(db, options);
  await upgradeLegacySchema(db);
  await db.batch(taprootSchemaStatements.map((sql) => db.prepare(sql)));
  await db
    .prepare(
      `INSERT INTO taproot_audit_events(
      event_id, entity_id, revision, event_type, attribution_json, edit_summary,
      tags_json, request_id, content_hash, parent_hash, details_json, created_at
    ) SELECT event_id, entity_id, revision,
      CASE WHEN revision = 1 THEN 'import' ELSE 'update' END,
      attribution_json, edit_summary, tags_json, NULL, content_hash, parent_hash,
      json_object('deletedAt', deleted_at, 'redirectTo', redirect_to), created_at
      FROM taproot_entity_revisions WHERE event_id IS NOT NULL AND content_hash IS NOT NULL
      ON CONFLICT(event_id) DO NOTHING`,
    )
    .run();
  await backfillRdfOwnership(db, previousRdfVersion);
  await db
    .prepare(
      `DELETE FROM taproot_metadata WHERE metadata_key = 'rdf_migration_from'`,
    )
    .run();
}

async function isRecognizedLegacyV1(
  db: SqliteDatabaseLike,
  tables: Array<{ name: string }>,
): Promise<boolean> {
  const expectedTables = [
    'taproot_assertions',
    'taproot_entities',
    'taproot_entity_revisions',
    'taproot_id_counters',
    'taproot_metadata',
    'taproot_terms',
  ];
  if (
    JSON.stringify(tables.map(({ name }) => name)) !==
    JSON.stringify(expectedTables)
  )
    return false;
  if (!(await matchesExactCatalog(db, legacyTaprootV1Statements))) return false;
  const metadata = await db
    .prepare(
      `SELECT metadata_key, metadata_value FROM taproot_metadata
       WHERE metadata_key IN ('schema_version', 'canonical_json_version', 'rdf_mapping_version')
       ORDER BY metadata_key`,
    )
    .all<{ metadata_key: string; metadata_value: string }>();
  return (
    JSON.stringify(metadata.results) ===
    JSON.stringify([
      { metadata_key: 'canonical_json_version', metadata_value: '1' },
      { metadata_key: 'rdf_mapping_version', metadata_value: '1' },
      { metadata_key: 'schema_version', metadata_value: '1' },
    ])
  );
}

async function readMetadata(
  db: SqliteDatabaseLike,
  key: string,
): Promise<string | undefined> {
  const table = await db
    .prepare(
      `SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'taproot_metadata'`,
    )
    .all<{ found: number }>();
  if (!table.results.length) return undefined;
  const result = await db
    .prepare(
      `SELECT metadata_value FROM taproot_metadata WHERE metadata_key = ?`,
    )
    .bind(key)
    .all<{ metadata_value: string }>();
  return result.results[0]?.metadata_value;
}

async function backfillRdfOwnership(
  db: SqliteDatabaseLike,
  previousVersion: string | undefined,
): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT entity_id, entity_json, deleted_at, redirect_to FROM taproot_entities ORDER BY entity_id`,
    )
    .all<{
      entity_id: EntityId;
      entity_json: string;
      deleted_at: string | null;
      redirect_to: EntityId | null;
    }>();
  if (!rows.results.length) return;
  const baseIri = await readMetadata(db, 'base_iri');
  if (!baseIri) return;
  const factory = new DataFactory();
  for (const row of rows.results) {
    const entity = parseEntityJson(row.entity_json);
    const current = lifecycleQuads(
      entity,
      row.deleted_at,
      row.redirect_to,
      baseIri,
      TAPROOT_RDF_VERSION,
      factory,
    );
    const existingOwnership = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM taproot_rdf_ownership WHERE entity_id = ?`,
      )
      .bind(row.entity_id)
      .all<{ count: number }>();
    if (
      previousVersion === TAPROOT_RDF_VERSION &&
      Number(existingOwnership.results[0]?.count ?? 0) > 0
    )
      continue;
    const old =
      previousVersion && previousVersion !== TAPROOT_RDF_VERSION
        ? lifecycleQuads(
            entity,
            row.deleted_at,
            row.redirect_to,
            baseIri,
            previousVersion,
            factory,
          )
        : [];
    const patch = prepareQuadPatch(db, { delete: old, insert: current });
    const ownershipRows = current.map((quad) => ({
      subjectKey: encodeTerm(quad.subject).key,
      predicateKey: encodeTerm(quad.predicate).key,
      objectKey: encodeTerm(quad.object).key,
      graphKey: encodeTerm(quad.graph).key,
    }));
    await db.batch([
      ...patch.statements,
      db
        .prepare(`DELETE FROM taproot_rdf_ownership WHERE entity_id = ?`)
        .bind(row.entity_id),
      db
        .prepare(
          `INSERT INTO taproot_rdf_ownership(entity_id, subject_key, predicate_key, object_key, graph_key)
         SELECT ?, json_extract(value, '$.subjectKey'), json_extract(value, '$.predicateKey'),
           json_extract(value, '$.objectKey'), json_extract(value, '$.graphKey') FROM json_each(?)`,
        )
        .bind(row.entity_id, JSON.stringify(ownershipRows)),
    ]);
  }
}

function lifecycleQuads(
  entity: WikibaseEntity,
  deletedAt: string | null,
  redirectTo: EntityId | null,
  baseIri: string,
  mappingVersion: string,
  factory: DataFactory,
) {
  if (!deletedAt && !redirectTo)
    return buildEntityQuads(entity, { baseIri, mappingVersion, factory });
  const base = baseIri.replace(/\/+$/u, '');
  const subject = factory.namedNode(`${base}/entity/${entity.id}`);
  const quads = [
    factory.quad(
      subject,
      factory.namedNode(`${base}/vocab/revision`),
      factory.literal(
        String(entity.lastrevid),
        factory.namedNode('http://www.w3.org/2001/XMLSchema#integer'),
      ),
    ),
  ];
  if (deletedAt)
    quads.push(
      factory.quad(
        subject,
        factory.namedNode(`${base}/vocab/deletedAt`),
        factory.literal(
          deletedAt,
          factory.namedNode('http://www.w3.org/2001/XMLSchema#dateTime'),
        ),
      ),
    );
  if (redirectTo)
    quads.push(
      factory.quad(
        subject,
        factory.namedNode('http://www.w3.org/2002/07/owl#sameAs'),
        factory.namedNode(`${base}/entity/${redirectTo}`),
      ),
    );
  return quads;
}

async function upgradeLegacySchema(db: SqliteDatabaseLike): Promise<void> {
  const tables = await db
    .prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'taproot_entity_revisions'`,
    )
    .all<{ name: string }>();
  if (!tables.results.length) return;
  const columns = await db
    .prepare(`PRAGMA table_info(taproot_entity_revisions)`)
    .all<{ name: string }>();
  const names = new Set(columns.results.map(({ name }) => name));
  const additions = [
    [
      'attribution_json',
      `TEXT CHECK (attribution_json IS NULL OR json_valid(attribution_json))`,
    ],
    ['tags_json', `TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json))`],
    ['event_id', `TEXT`],
    ['content_hash', `TEXT`],
    ['parent_hash', `TEXT`],
    ['deleted_at', `TEXT`],
    ['redirect_to', `TEXT`],
  ] as const;
  for (const [name, definition] of additions) {
    if (!names.has(name)) {
      await db
        .prepare(
          `ALTER TABLE taproot_entity_revisions ADD COLUMN ${name} ${definition}`,
        )
        .run();
    }
  }
  const revisions = await db
    .prepare(
      `SELECT r.entity_id, r.revision, r.entity_json, r.actor, r.event_id, r.content_hash,
       CASE WHEN r.revision = e.revision THEN e.deleted_at ELSE r.deleted_at END AS deleted_at,
       CASE WHEN r.revision = e.revision THEN e.redirect_to ELSE r.redirect_to END AS redirect_to
     FROM taproot_entity_revisions r JOIN taproot_entities e ON e.entity_id = r.entity_id
     ORDER BY r.entity_id, r.revision`,
    )
    .all<{
      entity_id: string;
      revision: number;
      entity_json: string;
      actor: string | null;
      event_id: string | null;
      content_hash: string | null;
      deleted_at: string | null;
      redirect_to: string | null;
    }>();
  let previousEntity = '';
  let parentHash: string | null = null;
  for (const revision of revisions.results) {
    if (revision.entity_id !== previousEntity) parentHash = null;
    const contentHash =
      revision.content_hash ??
      (await hash(
        `${revision.entity_json}\n${JSON.stringify({ deletedAt: revision.deleted_at, redirectTo: revision.redirect_to })}`,
      ));
    if (!revision.event_id || !revision.content_hash) {
      const attribution = revision.actor
        ? JSON.stringify({ id: revision.actor, kind: 'human' })
        : null;
      await db
        .prepare(
          `UPDATE taproot_entity_revisions SET event_id = ?, content_hash = ?,
          parent_hash = ?, attribution_json = COALESCE(attribution_json, ?),
          tags_json = COALESCE(tags_json, '[]'), deleted_at = ?, redirect_to = ?
          WHERE entity_id = ? AND revision = ?`,
        )
        .bind(
          revision.event_id ??
            `legacy-${revision.entity_id}-${revision.revision}`,
          contentHash,
          parentHash,
          attribution,
          revision.deleted_at,
          revision.redirect_to,
          revision.entity_id,
          revision.revision,
        )
        .run();
    }
    previousEntity = revision.entity_id;
    parentHash = contentHash;
  }
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function inspectTaprootSchema(
  db: SqliteDatabaseLike,
): Promise<TaprootSchemaInspection> {
  const required = [
    'taproot_entities',
    'taproot_entity_revisions',
    'taproot_id_counters',
    'taproot_terms',
    'taproot_metadata',
    'taproot_assertions',
    'taproot_audit_events',
    'taproot_migrations',
    'taproot_rdf_ownership',
  ];
  const tables = await db
    .prepare(
      `SELECT name, sql FROM sqlite_schema
       WHERE type = 'table' AND name LIKE 'taproot_%'`,
    )
    .all<{ name: string; sql: string | null }>();
  const names = new Set(tables.results.map(({ name }) => name));
  const missingTables = required.filter((name) => !names.has(name));
  const nonStrictTables = tables.results
    .filter(
      ({ name, sql }) =>
        required.includes(name) && !/\)\s*STRICT\s*$/iu.test(sql ?? ''),
    )
    .map(({ name }) => name);
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
  errors.push(...nonStrictTables.map((name) => `${name} is not STRICT`));
  const requiredRevisionColumns = [
    'attribution_json',
    'tags_json',
    'event_id',
    'content_hash',
    'parent_hash',
    'deleted_at',
    'redirect_to',
  ];
  const revisionColumns = names.has('taproot_entity_revisions')
    ? await db
        .prepare(`PRAGMA table_info(taproot_entity_revisions)`)
        .all<{ name: string }>()
    : { results: [] };
  const presentColumns = new Set(
    revisionColumns.results.map(({ name }) => name),
  );
  const missingColumns = requiredRevisionColumns.filter(
    (name) => !presentColumns.has(name),
  );
  const requiredIndexes = [
    'taproot_entities_type_idx',
    'taproot_entities_modified_idx',
    'taproot_revisions_entity_idx',
    'taproot_terms_lookup_idx',
    'taproot_audit_entity_idx',
    'taproot_audit_request_idx',
    'taproot_rdf_ownership_quad_idx',
  ];
  const indexRows = await db
    .prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'taproot_%'`,
    )
    .all<{ name: string }>();
  const presentIndexes = new Set(indexRows.results.map(({ name }) => name));
  const missingIndexes = requiredIndexes.filter(
    (name) => !presentIndexes.has(name),
  );
  const requiredTriggers = [
    'taproot_revisions_no_update',
    'taproot_revisions_no_delete',
    'taproot_audit_no_update',
    'taproot_audit_no_delete',
  ];
  const triggerRows = await db
    .prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'taproot_%'`,
    )
    .all<{ name: string }>();
  const presentTriggers = new Set(triggerRows.results.map(({ name }) => name));
  const missingTriggers = requiredTriggers.filter(
    (name) => !presentTriggers.has(name),
  );
  errors.push(
    ...missingColumns.map(
      (name) => `taproot_entity_revisions.${name} is missing`,
    ),
  );
  errors.push(...missingIndexes.map((name) => `${name} is missing`));
  errors.push(...missingTriggers.map((name) => `${name} is missing`));
  for (const [key, value] of Object.entries(expected)) {
    if (versions[key] !== value) {
      errors.push(`${key} is ${versions[key] ?? 'missing'}, expected ${value}`);
    }
  }
  return {
    valid: errors.length === 0,
    versions,
    missingTables,
    nonStrictTables,
    missingColumns,
    missingIndexes,
    missingTriggers,
    errors,
  };
}

/**
 * Verify the exact package-owned catalog before adopting a current pre-ledger
 * database. This is intentionally stricter than the operational inspection:
 * names alone must never authorize stamping an arbitrary look-alike schema.
 */
export async function isExactTaprootSchema(
  db: SqliteDatabaseLike,
): Promise<boolean> {
  return matchesExactCatalog(db, taprootSchemaStatements);
}

async function matchesExactCatalog(
  db: SqliteDatabaseLike,
  statements: readonly string[],
): Promise<boolean> {
  const expected = new Map<string, string>();
  for (const sql of statements) {
    const match =
      /^\s*CREATE\s+(TABLE|INDEX|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)/iu.exec(
        sql,
      );
    if (!match?.[1] || !match[2]) continue;
    expected.set(
      `${match[1].toLowerCase()}:${match[2]}`,
      normalizeCatalogSql(sql),
    );
  }
  const catalog = await db
    .prepare(
      `SELECT type, name, sql FROM sqlite_schema
       WHERE name LIKE 'taproot_%' AND type IN ('table', 'index', 'trigger')
       ORDER BY type, name`,
    )
    .all<{ type: string; name: string; sql: string | null }>();
  if (catalog.results.length !== expected.size) return false;
  for (const entry of catalog.results) {
    const expectedSql = expected.get(`${entry.type}:${entry.name}`);
    if (
      expectedSql === undefined ||
      entry.sql === null ||
      normalizeCatalogSql(entry.sql) !== expectedSql
    )
      return false;
  }
  return true;
}

function normalizeCatalogSql(sql: string): string {
  return sql
    .replace(/\bIF\s+NOT\s+EXISTS\s+/giu, '')
    .replace(/\s+/gu, ' ')
    .replace(/;\s*$/u, '')
    .trim()
    .toLowerCase();
}

export async function assertTaprootSchema(
  db: SqliteDatabaseLike,
): Promise<void> {
  const inspection = await inspectTaprootSchema(db);
  if (!inspection.valid) {
    throw new SchemaMismatchError(inspection.errors.join('; '));
  }
}
