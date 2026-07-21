import {
  checksumMigration,
  migrateDiamondStore,
  readAppliedMigrations,
  type AppliedMigration,
  type NamespacedMigration,
  type SqliteDatabaseLike,
} from '@gnolith/diamond';
import {
  BaseIriMismatchError,
  InvalidBaseIriError,
  SchemaMismatchError,
  TaprootMigrationStateError,
} from './errors.js';
import {
  TAPROOT_JSON_VERSION,
  TAPROOT_RDF_VERSION,
  TAPROOT_SCHEMA_VERSION,
  backfillLegacyRevisions,
  backfillRdfOwnership,
  backfillTaprootAudit,
  inspectTaprootSchema,
  isExactTaprootPreFinalizeSchema,
  isExactTaprootSchema,
  isExactTaprootUpgradeSchema,
  isRecognizedLegacyV1,
  legacyRevisionFinalizeStatements,
  legacyTaprootStructureStatements,
  taprootFinalizeStatements,
  taprootSchemaStatements,
  verifyTaprootPackageSeeds,
  verifyTaprootSemanticState,
} from './schema.js';

export const taprootMigrationNamespace = '@gnolith/taproot';

export const taprootMigrations = [
  { id: '0001-v0.1-schema', statements: taprootSchemaStatements },
  {
    id: '0002-durable-database-identity',
    statements: [
      `INSERT INTO taproot_metadata(metadata_key, metadata_value)
       VALUES ('migration_api_version', '1')
       ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value`,
    ],
  },
] as const satisfies readonly NamespacedMigration[];

type MigrationPhase = 'structure' | 'revisions' | 'audit' | 'rdf';
type MigrationSource = 'legacy' | 'current';
const migrationPhaseKey = 'migration_phase';
const migrationSourceKey = 'migration_source';
const migrationSourceRdfKey = 'migration_source_rdf_version';

export interface TaprootMigrationPlanEntry {
  id: string;
  checksum: string;
  status: 'applied' | 'adoptable' | 'pending';
  adopted: boolean;
}

export interface TaprootPersistenceInspection {
  baseIri: string | null;
  schema: Awaited<ReturnType<typeof inspectTaprootSchema>>;
  migrations: TaprootMigrationPlanEntry[];
  current: boolean;
}

export interface TaprootMigrationOptions {
  /** Required for a database that has not already recorded its identity. */
  baseIri?: string;
}

export function canonicalizeTaprootBaseIri(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new InvalidBaseIriError('baseIri must be an absolute HTTP(S) IRI', {
      cause,
    });
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  )
    throw new InvalidBaseIriError(
      'baseIri must be an absolute HTTP(S) IRI without credentials, query, or fragment',
    );
  const canonical = url.href.replace(/\/+$/u, '');
  if (!canonical) throw new InvalidBaseIriError('baseIri cannot be empty');
  return canonical;
}

export async function inspectTaprootPersistence(
  db: SqliteDatabaseLike,
): Promise<TaprootPersistenceInspection> {
  const schema = await inspectTaprootSchema(db);
  const baseIri = await readMetadata(db, 'base_iri');
  const phase = await readMetadata(db, migrationPhaseKey);
  const migrations = await planTaprootMigrations(db, schema);
  let semanticCurrent = false;
  const canonicalIdentity =
    baseIri === undefined ? undefined : tryCanonicalizeBaseIri(baseIri);
  if (
    schema.valid &&
    baseIri !== undefined &&
    canonicalIdentity === baseIri &&
    phase === undefined &&
    migrations.every(({ status }) => status === 'applied')
  ) {
    try {
      await verifyTaprootSemanticState(db, canonicalIdentity);
      await verifyTaprootPackageSeeds(db);
      semanticCurrent = true;
    } catch (cause) {
      if (!(cause instanceof SchemaMismatchError)) throw cause;
    }
  }
  return {
    baseIri: baseIri ?? null,
    schema,
    migrations,
    current: semanticCurrent,
  };
}

export async function planTaprootMigrations(
  db: SqliteDatabaseLike,
  knownSchema?: Awaited<ReturnType<typeof inspectTaprootSchema>>,
): Promise<TaprootMigrationPlanEntry[]> {
  const expected = await expectedMigrations();
  const ledgerExists = await tableExists(db, '_gnolith_migrations');
  const applied = ledgerExists
    ? await readAppliedMigrations(db, taprootMigrationNamespace)
    : [];
  validateApplied(applied, expected);
  const phase = await readMetadata(db, migrationPhaseKey);
  if (phase !== undefined) {
    await validateRecoveryState(db, phase, applied);
    return expected.map(({ migration, checksum }) => ({
      id: migration.id,
      checksum,
      status: 'pending',
      adopted: false,
    }));
  }
  if (applied.length > 0 && applied.length !== expected.length)
    throw new TaprootMigrationStateError(
      'Taproot migration ledger is partial and has no recovery marker',
    );
  const schema = knownSchema ?? (await inspectTaprootSchema(db));
  const taprootTableCount = await countTaprootTables(db);
  const exactCurrent =
    !applied.length &&
    taprootTableCount > 0 &&
    schema.valid &&
    (await isExactTaprootSchema(db));
  const legacy =
    !applied.length &&
    taprootTableCount > 0 &&
    (await legacyTables(db)).length > 0 &&
    (await isRecognizedLegacyV1(db, await legacyTables(db)));
  if (!applied.length && taprootTableCount > 0 && !exactCurrent && !legacy)
    throw new TaprootMigrationStateError(
      `Existing Taproot schema cannot be adopted exactly${schema.errors.length ? `: ${schema.errors.join('; ')}` : ': catalog definitions differ from the package manifest'}`,
    );
  return expected.map(({ migration, checksum }, index) => {
    const record = applied.find(({ id }) => id === migration.id);
    return {
      id: migration.id,
      checksum,
      status: record
        ? 'applied'
        : exactCurrent && index === 0
          ? 'adoptable'
          : 'pending',
      adopted: record?.adopted ?? false,
    };
  });
}

export async function applyTaprootMigrations(
  db: SqliteDatabaseLike,
  options: TaprootMigrationOptions = {},
): Promise<TaprootPersistenceInspection> {
  const requested =
    options.baseIri === undefined
      ? undefined
      : canonicalizeTaprootBaseIri(options.baseIri);
  const existingIdentity = await readMetadata(db, 'base_iri');
  if (existingIdentity === undefined && requested === undefined)
    throw new InvalidBaseIriError(
      'baseIri is required when initializing a Taproot database for the first time',
    );
  const canonicalExisting =
    existingIdentity === undefined
      ? undefined
      : canonicalizeTaprootBaseIri(existingIdentity);
  if (
    canonicalExisting !== undefined &&
    requested !== undefined &&
    canonicalExisting !== requested
  )
    throw new BaseIriMismatchError(
      `Taproot database identity is ${canonicalExisting}, not ${requested}`,
    );
  const identity = requested ?? canonicalExisting!;

  // Diamond owns its schema and ledger namespace. Its initialization is the
  // only prerequisite outside Taproot's package-owned transaction sequence.
  await migrateDiamondStore(db);
  const expected = await expectedMigrations();
  let applied = await readAppliedMigrations(db, taprootMigrationNamespace);
  validateApplied(applied, expected);
  let phase = await readMetadata(db, migrationPhaseKey);

  if (phase !== undefined) await validateRecoveryState(db, phase, applied);
  if (phase === undefined && applied.length > 0) {
    if (applied.length !== expected.length)
      throw new TaprootMigrationStateError(
        'Taproot migration ledger is partial and has no recovery marker',
      );
    if (!(await isExactTaprootSchema(db)))
      throw new TaprootMigrationStateError(
        'Applied Taproot migration ledger does not match the package catalog',
      );
    await writeCanonicalIdentity(db, identity, existingIdentity);
    try {
      await verifyTaprootSemanticState(db, identity);
      await verifyTaprootPackageSeeds(db);
      return inspectTaprootPersistence(db);
    } catch (cause) {
      if (!(cause instanceof SchemaMismatchError)) throw cause;
      await beginRecovery(db, 'current', TAPROOT_RDF_VERSION, identity, true);
      applied = [];
      phase = 'structure';
    }
  }

  if (phase === undefined) {
    const tables = await legacyTables(db);
    const count = await countTaprootTables(db);
    if (count === 0) {
      await initializeFresh(db, identity, expected);
      return inspectTaprootPersistence(db);
    }
    if (await isRecognizedLegacyV1(db, tables)) {
      await db.batch([
        ...legacyTaprootStructureStatements.map((sql) => db.prepare(sql)),
        ...recoveryMetadataStatements(
          db,
          'legacy',
          '1',
          identity,
          existingIdentity,
        ),
      ]);
      phase = 'structure';
    } else if (await isExactTaprootSchema(db)) {
      const previousRdf =
        (await readMetadata(db, 'rdf_mapping_version')) ?? '1';
      await beginRecovery(
        db,
        'current',
        previousRdf,
        identity,
        false,
        existingIdentity,
      );
      phase = 'structure';
    } else {
      const schema = await inspectTaprootSchema(db);
      throw new TaprootMigrationStateError(
        `Existing Taproot schema cannot be adopted exactly${schema.errors.length ? `: ${schema.errors.join('; ')}` : ': catalog definitions differ from the package manifest'}`,
      );
    }
  }

  while (phase !== undefined) {
    const source = await requireRecoverySource(db);
    if (phase === 'structure') {
      if (source === 'legacy') await backfillLegacyRevisions(db);
      await transitionPhase(
        db,
        'structure',
        'revisions',
        [
          `SELECT NULL WHERE EXISTS (
           SELECT 1 FROM taproot_entity_revisions
           WHERE event_id IS NULL OR content_hash IS NULL
         )`,
        ],
        source === 'legacy' ? legacyRevisionFinalizeStatements : [],
      );
      phase = 'revisions';
      continue;
    }
    if (phase === 'revisions') {
      await backfillTaprootAudit(db);
      await transitionPhase(db, 'revisions', 'audit', [
        `SELECT NULL WHERE EXISTS (
           SELECT 1 FROM taproot_entity_revisions r
           LEFT JOIN taproot_audit_events a ON a.event_id = r.event_id
           WHERE a.event_id IS NULL OR a.entity_id IS NOT r.entity_id
             OR a.revision IS NOT r.revision
             OR a.content_hash IS NOT r.content_hash
             OR a.parent_hash IS NOT r.parent_hash
             OR a.attribution_json IS NOT r.attribution_json
             OR a.edit_summary IS NOT r.edit_summary
             OR a.tags_json IS NOT r.tags_json
             OR a.created_at IS NOT r.created_at
         )`,
      ]);
      phase = 'audit';
      continue;
    }
    if (phase === 'audit') {
      const previousRdf = await readMetadata(db, migrationSourceRdfKey);
      await backfillRdfOwnership(db, previousRdf);
      await transitionPhase(db, 'audit', 'rdf');
      phase = 'rdf';
      continue;
    }
    if (phase === 'rdf') {
      await verifyTaprootSemanticState(db, identity);
      await finalizeRecovery(
        db,
        identity,
        expected,
        source !== 'current' || applied.length === 0,
      );
      phase = undefined;
      continue;
    }
    throw new TaprootMigrationStateError(
      `Unknown Taproot recovery phase ${phase}`,
    );
  }
  return inspectTaprootPersistence(db);
}

async function initializeFresh(
  db: SqliteDatabaseLike,
  identity: string,
  expected: Awaited<ReturnType<typeof expectedMigrations>>,
): Promise<void> {
  const appliedAt = new Date().toISOString();
  await db.batch([
    ...taprootSchemaStatements.map((sql) => db.prepare(sql)),
    ...identityStatements(db, identity),
    db.prepare(
      `INSERT INTO taproot_metadata(metadata_key, metadata_value)
       VALUES ('migration_api_version', '1')
       ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value`,
    ),
    ...ledgerStatements(db, expected, 0, appliedAt),
  ]);
}

async function beginRecovery(
  db: SqliteDatabaseLike,
  source: MigrationSource,
  previousRdf: string,
  identity: string,
  removeLedger: boolean,
  observedIdentity?: string,
): Promise<void> {
  await db.batch([
    ...(removeLedger
      ? [
          db
            .prepare(`DELETE FROM _gnolith_migrations WHERE namespace = ?`)
            .bind(taprootMigrationNamespace),
        ]
      : []),
    ...recoveryMetadataStatements(
      db,
      source,
      previousRdf,
      identity,
      observedIdentity,
    ),
  ]);
}

function recoveryMetadataStatements(
  db: SqliteDatabaseLike,
  source: MigrationSource,
  previousRdf: string,
  identity: string,
  observedIdentity?: string,
) {
  return [
    ...identityStatements(db, identity, observedIdentity),
    db
      .prepare(
        `INSERT INTO taproot_metadata(metadata_key, metadata_value)
         VALUES (?, 'structure'), (?, ?), (?, ?)
         ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value`,
      )
      .bind(
        migrationPhaseKey,
        migrationSourceKey,
        source,
        migrationSourceRdfKey,
        previousRdf,
      ),
  ];
}

async function transitionPhase(
  db: SqliteDatabaseLike,
  from: MigrationPhase,
  to: MigrationPhase,
  failureQueries: string[] = [],
  statements: readonly string[] = [],
): Promise<void> {
  await db.batch([
    ...failureQueries.map((sql) =>
      db.prepare(`INSERT INTO taproot_assertions(assertion_key) ${sql}`),
    ),
    ...statements.map((sql) => db.prepare(sql)),
    db
      .prepare(
        `INSERT INTO taproot_assertions(assertion_key)
         SELECT NULL WHERE NOT EXISTS (
           SELECT 1 FROM taproot_metadata
           WHERE metadata_key = ? AND metadata_value = ?
         )`,
      )
      .bind(migrationPhaseKey, from),
    db
      .prepare(
        `UPDATE taproot_metadata SET metadata_value = ?
         WHERE metadata_key = ? AND metadata_value = ?`,
      )
      .bind(to, migrationPhaseKey, from),
  ]);
}

async function finalizeRecovery(
  db: SqliteDatabaseLike,
  identity: string,
  expected: Awaited<ReturnType<typeof expectedMigrations>>,
  adopted: boolean,
): Promise<void> {
  const appliedAt = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO taproot_assertions(assertion_key)
         SELECT NULL WHERE NOT EXISTS (
           SELECT 1 FROM taproot_metadata
           WHERE metadata_key = ? AND metadata_value = 'rdf'
         )`,
      )
      .bind(migrationPhaseKey),
    ...taprootFinalizeStatements.map((sql) => db.prepare(sql)),
    ...identityStatements(db, identity),
    db.prepare(
      `INSERT INTO taproot_metadata(metadata_key, metadata_value)
       VALUES ('migration_api_version', '1')
       ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value`,
    ),
    db.prepare(
      `INSERT INTO taproot_assertions(assertion_key)
       SELECT NULL WHERE
         (SELECT COUNT(*) FROM taproot_migrations) != 2
         OR NOT EXISTS (
           SELECT 1 FROM taproot_migrations
           WHERE version = 1 AND name = 'initial'
         )
         OR NOT EXISTS (
           SELECT 1 FROM taproot_migrations
           WHERE version = 2 AND name = 'audit-and-operations'
         )`,
    ),
    ...ledgerStatements(db, expected, adopted ? 1 : 0, appliedAt),
    db
      .prepare(`DELETE FROM taproot_metadata WHERE metadata_key IN (?, ?, ?)`)
      .bind(migrationPhaseKey, migrationSourceKey, migrationSourceRdfKey),
  ]);
}

function identityStatements(
  db: SqliteDatabaseLike,
  identity: string,
  observedIdentity?: string,
) {
  return [
    db
      .prepare(
        `INSERT INTO taproot_metadata(metadata_key, metadata_value)
         VALUES ('base_iri', ?)
         ON CONFLICT(metadata_key) DO NOTHING`,
      )
      .bind(identity),
    ...(observedIdentity === undefined || observedIdentity === identity
      ? []
      : [
          db
            .prepare(
              `UPDATE taproot_metadata SET metadata_value = ?
               WHERE metadata_key = 'base_iri' AND metadata_value = ?`,
            )
            .bind(identity, observedIdentity),
        ]),
    db
      .prepare(
        `INSERT INTO taproot_assertions(assertion_key)
         SELECT NULL WHERE NOT EXISTS (
           SELECT 1 FROM taproot_metadata
           WHERE metadata_key = 'base_iri' AND metadata_value = ?
         )`,
      )
      .bind(identity),
  ];
}

function ledgerStatements(
  db: SqliteDatabaseLike,
  expected: Awaited<ReturnType<typeof expectedMigrations>>,
  adopted: 0 | 1,
  appliedAt: string,
) {
  return expected.map(({ migration, checksum }) =>
    db
      .prepare(
        `INSERT INTO _gnolith_migrations
           (namespace, migration_id, checksum, adopted, applied_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        taprootMigrationNamespace,
        migration.id,
        checksum,
        adopted,
        appliedAt,
      ),
  );
}

async function writeCanonicalIdentity(
  db: SqliteDatabaseLike,
  identity: string,
  observedIdentity?: string,
): Promise<void> {
  await db.batch(identityStatements(db, identity, observedIdentity));
}

function tryCanonicalizeBaseIri(value: string): string | undefined {
  try {
    return canonicalizeTaprootBaseIri(value);
  } catch {
    return undefined;
  }
}

async function validateRecoveryState(
  db: SqliteDatabaseLike,
  phase: string,
  applied: AppliedMigration[],
): Promise<void> {
  if (!['structure', 'revisions', 'audit', 'rdf'].includes(phase))
    throw new TaprootMigrationStateError(
      `Unknown Taproot recovery phase ${phase}`,
    );
  if (applied.length)
    throw new TaprootMigrationStateError(
      'Taproot recovery marker cannot coexist with applied ledger entries',
    );
  const source = await requireRecoverySource(db);
  const exact =
    source === 'legacy'
      ? phase === 'structure'
        ? await isExactTaprootUpgradeSchema(db)
        : await isExactTaprootPreFinalizeSchema(db)
      : await isExactTaprootSchema(db);
  if (!exact)
    throw new TaprootMigrationStateError(
      'Taproot recovery catalog differs from its durable recovery source',
    );
  if ((await readMetadata(db, migrationSourceRdfKey)) === undefined)
    throw new TaprootMigrationStateError(
      'Taproot recovery source RDF version is missing',
    );
}

async function requireRecoverySource(
  db: SqliteDatabaseLike,
): Promise<MigrationSource> {
  const source = await readMetadata(db, migrationSourceKey);
  if (source !== 'legacy' && source !== 'current')
    throw new TaprootMigrationStateError(
      `Unknown Taproot recovery source ${source ?? 'missing'}`,
    );
  return source;
}

async function expectedMigrations() {
  return Promise.all(
    taprootMigrations.map(async (migration) => ({
      migration,
      checksum: await checksumMigration(migration),
    })),
  );
}

async function readMetadata(
  db: SqliteDatabaseLike,
  key: string,
): Promise<string | undefined> {
  if (!(await tableExists(db, 'taproot_metadata'))) return undefined;
  const result = await db
    .prepare(
      `SELECT metadata_value FROM taproot_metadata WHERE metadata_key = ?`,
    )
    .bind(key)
    .all<{ metadata_value: string }>();
  return result.results[0]?.metadata_value;
}

async function tableExists(
  db: SqliteDatabaseLike,
  name: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = ?`,
    )
    .bind(name)
    .all<{ found: number }>();
  return result.results.length > 0;
}

async function countTaprootTables(db: SqliteDatabaseLike): Promise<number> {
  const result = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM sqlite_schema
       WHERE type = 'table' AND name LIKE 'taproot_%'`,
    )
    .all<{ count: number }>();
  return Number(result.results[0]?.count ?? 0);
}

async function legacyTables(db: SqliteDatabaseLike) {
  const result = await db
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name LIKE 'taproot_%' ORDER BY name`,
    )
    .all<{ name: string }>();
  return result.results;
}

function validateApplied(
  applied: AppliedMigration[],
  expected: Array<{ migration: NamespacedMigration; checksum: string }>,
): void {
  const expectedById = new Map(
    expected.map(({ migration, checksum }) => [migration.id, checksum]),
  );
  for (const record of applied) {
    const checksum = expectedById.get(record.id);
    if (!checksum)
      throw new TaprootMigrationStateError(
        `Unknown Taproot migration ${record.id}`,
      );
    if (checksum !== record.checksum)
      throw new TaprootMigrationStateError(
        `Checksum drift detected for Taproot migration ${record.id}`,
      );
  }
  let gap = false;
  const appliedIds = new Set(applied.map(({ id }) => id));
  for (const { migration } of expected) {
    if (!appliedIds.has(migration.id)) gap = true;
    else if (gap)
      throw new TaprootMigrationStateError(
        `Taproot migration history is out of order at ${migration.id}`,
      );
  }
}

export const taprootPersistenceVersions = {
  schema: TAPROOT_SCHEMA_VERSION,
  canonicalJson: TAPROOT_JSON_VERSION,
  rdfMapping: TAPROOT_RDF_VERSION,
} as const;
