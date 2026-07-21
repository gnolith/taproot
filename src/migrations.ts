import {
  MigrationStateError,
  applyNamespacedMigrations,
  checksumMigration,
  migrateDiamondStore,
  readAppliedMigrations,
  recordMigrationAdoption,
  type AppliedMigration,
  type NamespacedMigration,
  type SqliteDatabaseLike,
} from '@gnolith/diamond';
import {
  BaseIriMismatchError,
  InvalidBaseIriError,
  TaprootMigrationStateError,
} from './errors.js';
import {
  TAPROOT_JSON_VERSION,
  TAPROOT_RDF_VERSION,
  TAPROOT_SCHEMA_VERSION,
  isExactTaprootSchema,
  inspectTaprootSchema,
  taprootSchemaStatements,
} from './schema.js';

export const taprootMigrationNamespace = '@gnolith/taproot';

export const taprootMigrations = [
  {
    id: '0001-v0.1-schema',
    statements: taprootSchemaStatements,
  },
  {
    id: '0002-durable-database-identity',
    statements: [
      `INSERT INTO taproot_metadata(metadata_key, metadata_value)
       VALUES ('migration_api_version', '1')
       ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value`,
    ],
  },
] as const satisfies readonly NamespacedMigration[];

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
  ) {
    throw new InvalidBaseIriError(
      'baseIri must be an absolute HTTP(S) IRI without credentials, query, or fragment',
    );
  }
  const canonical = url.href.replace(/\/+$/u, '');
  if (!canonical) throw new InvalidBaseIriError('baseIri cannot be empty');
  return canonical;
}

export async function inspectTaprootPersistence(
  db: SqliteDatabaseLike,
): Promise<TaprootPersistenceInspection> {
  const schema = await inspectTaprootSchema(db);
  const baseIri = await readMetadata(db, 'base_iri');
  const migrations = await planTaprootMigrations(db, schema);
  return {
    baseIri: baseIri ?? null,
    schema,
    migrations,
    current:
      schema.valid &&
      baseIri !== undefined &&
      migrations.every(({ status }) => status === 'applied'),
  };
}

export async function planTaprootMigrations(
  db: SqliteDatabaseLike,
  knownSchema?: Awaited<ReturnType<typeof inspectTaprootSchema>>,
): Promise<TaprootMigrationPlanEntry[]> {
  const expected = await Promise.all(
    taprootMigrations.map(async (migration) => ({
      migration,
      checksum: await checksumMigration(migration),
    })),
  );
  const ledgerExists = await tableExists(db, '_gnolith_migrations');
  let applied: AppliedMigration[] = [];
  if (ledgerExists) {
    applied = await readAppliedMigrations(db, taprootMigrationNamespace);
    validateApplied(applied, expected);
  }
  const schema = knownSchema ?? (await inspectTaprootSchema(db));
  const taprootTableCount = await countTaprootTables(db);
  const exactCurrent =
    !applied.length &&
    taprootTableCount > 0 &&
    schema.valid &&
    (await isExactTaprootSchema(db));
  const mayAdopt = !applied.length && exactCurrent;
  if (!applied.length && taprootTableCount > 0 && !exactCurrent) {
    throw new TaprootMigrationStateError(
      `Existing Taproot schema cannot be adopted exactly${schema.errors.length ? `: ${schema.errors.join('; ')}` : ': catalog definitions differ from the package manifest'}`,
    );
  }
  return expected.map(({ migration, checksum }, index) => {
    const record = applied.find(({ id }) => id === migration.id);
    return {
      id: migration.id,
      checksum,
      status: record
        ? 'applied'
        : mayAdopt && index === 0
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
  if (existingIdentity === undefined && requested === undefined) {
    throw new InvalidBaseIriError(
      'baseIri is required when initializing a Taproot database for the first time',
    );
  }
  if (existingIdentity !== undefined && requested !== undefined) {
    const canonicalExisting = canonicalizeTaprootBaseIri(existingIdentity);
    if (canonicalExisting !== requested) {
      throw new BaseIriMismatchError(
        `Taproot database identity is ${canonicalExisting}, not ${requested}`,
      );
    }
  }

  // Diamond owns its schema and ledger namespace; Taproot only orchestrates
  // the prerequisite before applying its own package-owned namespace.
  await migrateDiamondStore(db);
  const plan = await planTaprootMigrations(db);
  if (plan[0]?.status === 'adoptable') {
    await recordMigrationAdoption(
      db,
      taprootMigrationNamespace,
      taprootMigrations[0],
    );
  }
  try {
    await applyNamespacedMigrations(
      db,
      taprootMigrationNamespace,
      taprootMigrations,
    );
  } catch (cause) {
    if (cause instanceof MigrationStateError) {
      throw new TaprootMigrationStateError(cause.message, { cause });
    }
    throw cause;
  }

  const identity = requested ?? canonicalizeTaprootBaseIri(existingIdentity!);
  await db.batch([
    db
      .prepare(
        `INSERT INTO taproot_metadata(metadata_key, metadata_value)
         VALUES ('base_iri', ?)
         ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value`,
      )
      .bind(identity),
    db
      .prepare(
        `INSERT INTO taproot_assertions(assertion_key)
         SELECT NULL WHERE NOT EXISTS (
           SELECT 1 FROM taproot_metadata
           WHERE metadata_key = 'base_iri' AND metadata_value = ?
         )`,
      )
      .bind(identity),
  ]);
  const stored = await readMetadata(db, 'base_iri');
  if (stored !== identity) {
    throw new BaseIriMismatchError(
      `Taproot database identity is ${stored ?? 'missing'}, not ${identity}`,
    );
  }
  return inspectTaprootPersistence(db);
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
