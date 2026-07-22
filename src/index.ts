import type {
  D1DatabaseLike,
  SqlitePreparedStatementLike,
  SqliteResultLike,
} from '@gnolith/diamond';
import { InvalidAuthorizationError } from './errors.js';
import { canonicalizeTaprootBaseIri } from './migrations.js';
import {
  KNOWLEDGE_WRITE_CAPABILITY,
  normalizeAuthorizationContext,
  type InstallationAuthorizationState,
} from './authorization.js';
import {
  applyAuthorizationBackfill as applyAuthorizationBackfillInternal,
  inspectAuthorizationReadiness as inspectAuthorizationReadinessInternal,
  planAuthorizationBackfill as planAuthorizationBackfillInternal,
  type AuthorizationBackfillEntityInput,
} from './authorization-maintenance.js';
export type {
  AuthorizationBackfillEntityInput,
  AuthorizationBackfillPlan,
  AuthorizationBackfillRevisionInput,
  AuthorizationReadinessCode,
  AuthorizationReadinessInspection,
  AuthorizationReadinessIssue,
} from './authorization-maintenance.js';
export type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
  SqliteDatabaseLike,
  SqlitePreparedStatementLike,
  SqliteResultLike,
} from '@gnolith/diamond';
import {
  TaprootRepository,
  type CreateItemInput,
  type CreatePropertyInput,
  type BulkImportOptions,
  type LegacyAuthorizationBootstrapAttestation,
} from './repository.js';
export type {
  BulkImportOptions,
  CreateItemInput,
  CreatePropertyInput,
  ListAuditOptions,
  ListEntitiesOptions,
  SearchOptions,
  LegacyAuthorizationBootstrapAttestation,
} from './repository.js';
import type {
  EditMetadata,
  EntityId,
  EntityCommand,
  ExpectedRevision,
  PropertyId,
  Reference,
  Sitelink,
  Snak,
  Statement,
  StatementRevisionEdit,
  TaprootOptions,
  WikibaseEntity,
  WriteResult,
  CanonicalAuthorizationPolicyInput,
  AuthorizationContext,
} from './types.js';

export type AuthorizedExpectedRevision = Omit<
  ExpectedRevision,
  'authorization' | 'authorizationContext'
> & { authorization: CanonicalAuthorizationPolicyInput };
export type AuthorizedStatementRevisionEdit = Omit<
  StatementRevisionEdit,
  'authorization' | 'authorizationContext'
> & { authorization: CanonicalAuthorizationPolicyInput };
export type AuthorizedCreateItemInput = Omit<
  CreateItemInput,
  'authorization' | 'authorizationContext'
> & { authorization: CanonicalAuthorizationPolicyInput };
export type AuthorizedCreatePropertyInput = Omit<
  CreatePropertyInput,
  'authorization' | 'authorizationContext'
> & { authorization: CanonicalAuthorizationPolicyInput };
export type AuthorizedImportMetadata = Omit<
  EditMetadata,
  'authorization' | 'authorizationContext'
> & {
  authorization: CanonicalAuthorizationPolicyInput;
};
export type AuthorizedBulkImportOptions = Omit<
  BulkImportOptions,
  'authorizations'
> & {
  authorizations: Readonly<Record<EntityId, CanonicalAuthorizationPolicyInput>>;
};

export interface TaprootHostWriteCapability {
  readonly kind: 'taproot-host-write-v1';
}

const hostWriteCapabilities = new WeakMap<
  object,
  { db: D1DatabaseLike; baseIri: string }
>();

export interface InstallationAuthorizationGuard {
  readonly kind: 'taproot-installation-authorization-guard-v1';
  readCurrentState(): Promise<InstallationAuthorizationState>;
  batchWithExpectedRevision(
    context: AuthorizationContext,
    statements: readonly SqlitePreparedStatementLike[],
  ): Promise<readonly SqliteResultLike[]>;
  batchWithAuthorizationAdvance(
    context: AuthorizationContext,
    audit: { advanceId: string; domain: string; reason: string },
    statements: readonly SqlitePreparedStatementLike[],
  ): Promise<{
    authorizationRevision: number;
    searchGeneration: number;
    results: readonly SqliteResultLike[];
  }>;
}

interface InstallationGuardBinding {
  db: D1DatabaseLike;
  baseIri: string;
  installationId: string;
  clock: () => Date;
}

const installationAuthorizationGuards = new WeakMap<
  object,
  InstallationGuardBinding
>();

interface InternalInstallationAuthorizationState extends InstallationAuthorizationState {
  lastAdvanceId: string;
}

/**
 * Issues the non-user capability required by public mutation helpers. The
 * non-extractable key is host assembly state and must never enter transport
 * arguments. Taproot uses object identity, not caller-supplied fields.
 */
export function createTaprootHostWriteCapability(
  db: D1DatabaseLike,
  options: Pick<TaprootWriteOptions, 'baseIri'>,
  key: CryptoKey,
): TaprootHostWriteCapability {
  const algorithm = key.algorithm as KeyAlgorithm & {
    hash?: KeyAlgorithm;
  };
  if (
    key.type !== 'secret' ||
    key.extractable ||
    algorithm.name !== 'HMAC' ||
    algorithm.hash?.name !== 'SHA-256' ||
    !key.usages.includes('sign')
  )
    throw new InvalidAuthorizationError(
      'write capability key must be non-extractable HMAC-SHA-256 with sign usage',
    );
  const capability = Object.freeze({ kind: 'taproot-host-write-v1' as const });
  hostWriteCapabilities.set(capability, {
    db,
    baseIri: canonicalizeTaprootBaseIri(options.baseIri),
  });
  return capability;
}

export * from './canonical.js';
export * from './authorization.js';
export * from './errors.js';
export * from './migrations.js';
export * from './rdf.js';
export * from './schema.js';
export * from './types.js';

function repository(
  db: D1DatabaseLike,
  options: Readonly<TaprootWriteOptions>,
  capability: TaprootHostWriteCapability,
): TaprootRepository {
  const binding = hostWriteCapabilities.get(capability);
  if (
    !binding ||
    binding.db !== db ||
    binding.baseIri !== canonicalizeTaprootBaseIri(options.baseIri)
  )
    throw new InvalidAuthorizationError(
      'host-issued write capability is required',
    );
  if (
    'validators' in options ||
    'factory' in options ||
    'maxEntityBytes' in options
  )
    throw new InvalidAuthorizationError(
      'write options cannot install canonical-state observers or size probes',
    );
  return new TaprootRepository(db, options);
}

function guardedRepository(
  db: D1DatabaseLike,
  options: Readonly<TaprootWriteOptions>,
  guard: InstallationAuthorizationGuard,
  rawContext: AuthorizationContext,
): { repository: TaprootRepository; context: AuthorizationContext } {
  const binding = installationAuthorizationGuards.get(guard);
  if (
    !binding ||
    binding.db !== db ||
    binding.baseIri !== canonicalizeTaprootBaseIri(options.baseIri)
  )
    throw new InvalidAuthorizationError(
      'assembly-issued installation authorization guard is required',
    );
  const context = normalizeAuthorizationContext(rawContext);
  if (
    context.installationId !== binding.installationId ||
    !context.capabilities.includes(KNOWLEDGE_WRITE_CAPABILITY)
  )
    throw new InvalidAuthorizationError('knowledge write authorization denied');
  if (
    'validators' in options ||
    'factory' in options ||
    'maxEntityBytes' in options
  )
    throw new InvalidAuthorizationError(
      'write options cannot install canonical-state observers or size probes',
    );
  return { repository: new TaprootRepository(db, options), context };
}

async function readInstallationAuthorizationState(
  db: D1DatabaseLike,
): Promise<InternalInstallationAuthorizationState> {
  const result = await db
    .prepare(
      `SELECT installation_id, authorization_revision, search_generation, last_advance_id
       FROM taproot_installation_authorization WHERE singleton = 1`,
    )
    .all<{
      installation_id: string;
      authorization_revision: number;
      search_generation: number;
      last_advance_id: string;
    }>();
  const row = result.results[0];
  if (!row)
    throw new InvalidAuthorizationError(
      'installation authorization has not been bootstrapped',
    );
  return {
    installationId: row.installation_id,
    authorizationRevision: Number(row.authorization_revision),
    searchGeneration: Number(row.search_generation),
    lastAdvanceId: row.last_advance_id,
  };
}

async function readGuardState(
  binding: InstallationGuardBinding,
): Promise<InternalInstallationAuthorizationState> {
  const state = await readInstallationAuthorizationState(binding.db);
  if (state.installationId !== binding.installationId)
    throw new InvalidAuthorizationError('installation authorization denied');
  return state;
}

async function prepareGuardFence(
  binding: InstallationGuardBinding,
  rawContext: AuthorizationContext,
): Promise<SqlitePreparedStatementLike> {
  const context = normalizeAuthorizationContext(rawContext);
  const state = await readGuardState(binding);
  if (
    context.installationId !== state.installationId ||
    context.authorizationRevision !== state.authorizationRevision ||
    !context.capabilities.includes(KNOWLEDGE_WRITE_CAPABILITY)
  )
    throw new InvalidAuthorizationError('installation authorization denied');
  return binding.db
    .prepare(
      `INSERT INTO taproot_assertions(assertion_key)
       SELECT NULL WHERE NOT EXISTS (
         SELECT 1 FROM taproot_installation_authorization
          WHERE singleton = 1 AND installation_id = ?
            AND authorization_revision = ? AND search_generation = ?
            AND last_advance_id = ?
       )`,
    )
    .bind(
      state.installationId,
      state.authorizationRevision,
      state.searchGeneration,
      state.lastAdvanceId,
    );
}

async function prepareGuardAdvance(
  binding: InstallationGuardBinding,
  rawContext: AuthorizationContext,
  audit: { advanceId: string; domain: string; reason: string },
) {
  const context = normalizeAuthorizationContext(rawContext);
  const state = await readGuardState(binding);
  if (
    context.installationId !== state.installationId ||
    context.authorizationRevision !== state.authorizationRevision ||
    !context.capabilities.includes(KNOWLEDGE_WRITE_CAPABILITY)
  )
    throw new InvalidAuthorizationError('installation authorization denied');
  for (const [field, value, maximum] of [
    ['advanceId', audit.advanceId, 128],
    ['domain', audit.domain, 64],
    ['reason', audit.reason, 512],
  ] as const) {
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value !== value.trim() ||
      value.length > maximum ||
      [...value].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      })
    )
      throw new InvalidAuthorizationError(`${field} is invalid`);
  }
  const authorizationRevision = state.authorizationRevision + 1;
  const searchGeneration = state.searchGeneration + 1;
  const createdAt = binding.clock().toISOString();
  const statements = Object.freeze([
    binding.db
      .prepare(
        `UPDATE taproot_installation_authorization
         SET authorization_revision = ?, search_generation = ?, last_advance_id = ?, updated_at = ?
         WHERE singleton = 1 AND installation_id = ?
           AND authorization_revision = ? AND search_generation = ?`,
      )
      .bind(
        authorizationRevision,
        searchGeneration,
        audit.advanceId,
        createdAt,
        state.installationId,
        state.authorizationRevision,
        state.searchGeneration,
      ),
    binding.db
      .prepare(
        `INSERT INTO taproot_assertions(assertion_key)
         SELECT NULL WHERE NOT EXISTS (
           SELECT 1 FROM taproot_installation_authorization
            WHERE singleton = 1 AND installation_id = ?
              AND authorization_revision = ? AND search_generation = ?
              AND last_advance_id = ?
         )`,
      )
      .bind(
        state.installationId,
        authorizationRevision,
        searchGeneration,
        audit.advanceId,
      ),
    binding.db
      .prepare(
        `INSERT INTO taproot_installation_authorization_advances(
           advance_id, installation_id, from_revision, to_revision,
           search_generation, domain, principal_id, reason, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        audit.advanceId,
        state.installationId,
        state.authorizationRevision,
        authorizationRevision,
        searchGeneration,
        audit.domain,
        context.principalId,
        audit.reason,
        createdAt,
      ),
  ]);
  return { authorizationRevision, searchGeneration, statements };
}

function validateGuardDomainStatements(
  statements: readonly SqlitePreparedStatementLike[],
): void {
  if (
    !Array.isArray(statements) ||
    statements.length < 1 ||
    statements.length > 100
  )
    throw new InvalidAuthorizationError(
      'an authorization batch must contain 1 through 100 domain statements',
    );
}

/**
 * Assembly-only pristine bootstrap for immutable installation authorization.
 * It cannot be used after canonical entities exist.
 */
export const bootstrapTaprootAuthorization = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  installationId: string,
) => repository(db, options, capability).bootstrapAuthorization(installationId);

export const bootstrapLegacyTaprootAuthorization = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  installationId: string,
  attestation: LegacyAuthorizationBootstrapAttestation,
) =>
  repository(db, options, capability).bootstrapLegacyAuthorization(
    installationId,
    attestation,
  );

/** Assembly issues this opaque guard after authorization bootstrap. */
export async function createInstallationAuthorizationGuard(
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
): Promise<InstallationAuthorizationGuard> {
  repository(db, options, capability);
  const state = await readInstallationAuthorizationState(db);
  const binding: InstallationGuardBinding = {
    db,
    baseIri: canonicalizeTaprootBaseIri(options.baseIri),
    installationId: state.installationId,
    clock: options.clock ?? (() => new Date()),
  };
  const guard: InstallationAuthorizationGuard = Object.freeze({
    kind: 'taproot-installation-authorization-guard-v1' as const,
    readCurrentState: () => readGuardState(binding),
    batchWithExpectedRevision: async (
      context: AuthorizationContext,
      statements: readonly SqlitePreparedStatementLike[],
    ) => {
      validateGuardDomainStatements(statements);
      return binding.db.batch([
        ...statements,
        await prepareGuardFence(binding, context),
      ]);
    },
    batchWithAuthorizationAdvance: async (
      context: AuthorizationContext,
      audit: { advanceId: string; domain: string; reason: string },
      domainStatements: readonly SqlitePreparedStatementLike[],
    ) => {
      validateGuardDomainStatements(domainStatements);
      const advance = await prepareGuardAdvance(binding, context, audit);
      const results = await binding.db.batch([
        ...domainStatements,
        ...advance.statements,
      ]);
      return {
        authorizationRevision: advance.authorizationRevision,
        searchGeneration: advance.searchGeneration,
        results,
      };
    },
  });
  installationAuthorizationGuards.set(guard, binding);
  return guard;
}

export const inspectTaprootAuthorizationReadiness = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  context: AuthorizationContext,
  inspection?: { limit?: number; cursor?: EntityId },
) => {
  repository(db, options, capability);
  return inspectAuthorizationReadinessInternal(db, context, inspection);
};

export const planTaprootAuthorizationBackfill = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  context: AuthorizationContext,
  inputs: readonly AuthorizationBackfillEntityInput[],
) => {
  repository(db, options, capability);
  return planAuthorizationBackfillInternal(db, context, inputs);
};

export const applyTaprootAuthorizationBackfill = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  context: AuthorizationContext,
  planId: string,
) => {
  repository(db, options, capability);
  return applyAuthorizationBackfillInternal(db, context, planId);
};

export interface MutationReceipt {
  entityId: EntityId;
  previousRevision: number | null;
  newRevision: number;
  status: 'committed';
  authorizationRevision: number;
  searchGeneration: number;
}

/** Write configuration cannot install a callback that observes canonical state. */
export type TaprootWriteOptions = Omit<
  TaprootOptions,
  'validators' | 'factory' | 'maxEntityBytes'
> & {
  validators?: never;
  factory?: never;
  maxEntityBytes?: never;
};

export interface BulkMutationReceipt {
  succeeded: MutationReceipt[];
  failed: Array<{ index: number; entityId?: EntityId; error: Error }>;
}

function mutationReceipt(result: WriteResult): MutationReceipt {
  return {
    entityId: result.entityId,
    previousRevision: result.previousRevision,
    newRevision: result.newRevision,
    status: 'committed',
    authorizationRevision: result.authorizationRevision!,
    searchGeneration: result.searchGeneration!,
  };
}

async function mutation(
  operation: Promise<WriteResult>,
): Promise<MutationReceipt> {
  return mutationReceipt(await operation);
}

function writeMetadata<T extends object>(
  value: T,
  context: AuthorizationContext,
): T & { authorizationContext: AuthorizationContext } {
  const authorization = (value as { authorization?: unknown }).authorization;
  if (!Object.hasOwn(value, 'authorization') || authorization === undefined)
    throw new InvalidAuthorizationError(
      'canonical authorization policy is required for every write',
    );
  return { ...value, authorizationContext: context };
}

function guardedWrite(
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  operation: (
    repository: TaprootRepository,
    normalizedContext: AuthorizationContext,
  ) => Promise<WriteResult>,
): Promise<MutationReceipt> {
  const bound = guardedRepository(db, options, guard, context);
  return mutation(operation(bound.repository, bound.context));
}

export const createItem = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  input: AuthorizedCreateItemInput,
) => {
  const bound = guardedRepository(db, options, guard, context);
  return mutation(
    bound.repository.createItem(writeMetadata(input, bound.context)),
  );
};

export const createProperty = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  input: AuthorizedCreatePropertyInput,
) => {
  const bound = guardedRepository(db, options, guard, context);
  return mutation(
    bound.repository.createProperty(writeMetadata(input, bound.context)),
  );
};

export const importEntity = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  entity: WikibaseEntity,
  metadata: AuthorizedImportMetadata,
) => {
  const bound = guardedRepository(db, options, guard, context);
  return mutation(
    bound.repository.importEntity(
      entity,
      writeMetadata(metadata, bound.context),
    ),
  );
};

export const importEntities = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  entities: Iterable<WikibaseEntity>,
  bulk: AuthorizedBulkImportOptions,
) => {
  const values = [...entities];
  if (
    typeof bulk !== 'object' ||
    bulk === null ||
    typeof bulk.authorizations !== 'object' ||
    bulk.authorizations === null ||
    Array.isArray(bulk.authorizations)
  )
    throw new InvalidAuthorizationError(
      'bulk authorizations must explicitly and exactly cover imported entities',
    );
  const expected = [...new Set(values.map(({ id }) => id))].sort();
  const provided = Object.keys(bulk.authorizations).sort();
  if (JSON.stringify(expected) !== JSON.stringify(provided))
    throw new InvalidAuthorizationError(
      'bulk authorizations must explicitly and exactly cover imported entities',
    );
  const bound = guardedRepository(db, options, guard, context);
  return bound.repository
    .importEntities(values, {
      ...bulk,
      metadata: {
        ...(bulk.metadata ?? {}),
        authorizationContext: bound.context,
      },
    })
    .then((result): BulkMutationReceipt => ({
      succeeded: result.succeeded.map(mutationReceipt),
      failed: result.failed,
    }));
};

export const applyCommands = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: EntityId,
  commands: readonly EntityCommand[],
  edit: AuthorizedExpectedRevision,
) =>
  mutation(
    guardedRepository(db, options, guard, context).repository.applyCommands(
      id,
      commands,
      writeMetadata(edit, normalizeAuthorizationContext(context)),
    ),
  );

export const replaceEntity = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: EntityId,
  entity: WikibaseEntity,
  edit: AuthorizedStatementRevisionEdit,
) =>
  mutation(
    guardedRepository(db, options, guard, context).repository.replaceEntity(
      id,
      entity,
      writeMetadata(edit, normalizeAuthorizationContext(context)),
    ),
  );

export const revertEntity = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: EntityId,
  targetRevision: number,
  edit: AuthorizedStatementRevisionEdit,
) =>
  mutation(
    guardedRepository(db, options, guard, context).repository.revertEntity(
      id,
      targetRevision,
      writeMetadata(edit, normalizeAuthorizationContext(context)),
    ),
  );

export const softDeleteEntity = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: EntityId,
  edit: AuthorizedExpectedRevision,
) =>
  mutation(
    guardedRepository(db, options, guard, context).repository.softDeleteEntity(
      id,
      writeMetadata(edit, normalizeAuthorizationContext(context)),
    ),
  );

export const restoreEntity = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: EntityId,
  edit: AuthorizedExpectedRevision,
) =>
  guardedWrite(db, options, guard, context, (repo, ctx) =>
    repo.restoreEntity(id, writeMetadata(edit, ctx)),
  );

export const redirectEntity = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: EntityId,
  target: EntityId,
  edit: AuthorizedExpectedRevision,
) =>
  guardedWrite(db, options, guard, context, (repo, ctx) =>
    repo.redirectEntity(id, target, writeMetadata(edit, ctx)),
  );

export const setLabel = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: EntityId,
  language: string,
  value: string,
  edit: AuthorizedExpectedRevision,
) =>
  guardedWrite(db, options, guard, context, (repo, ctx) =>
    repo.setLabel(id, language, value, writeMetadata(edit, ctx)),
  );

export const removeLabel = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: EntityId,
  language: string,
  edit: AuthorizedExpectedRevision,
) =>
  guardedWrite(db, options, guard, context, (repo, ctx) =>
    repo.removeLabel(id, language, writeMetadata(edit, ctx)),
  );

export const setDescription = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: EntityId,
  language: string,
  value: string,
  edit: AuthorizedExpectedRevision,
) =>
  guardedWrite(db, options, guard, context, (repo, ctx) =>
    repo.setDescription(id, language, value, writeMetadata(edit, ctx)),
  );

export const removeDescription = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: EntityId,
  language: string,
  edit: AuthorizedExpectedRevision,
) =>
  guardedWrite(db, options, guard, context, (repo, ctx) =>
    repo.removeDescription(id, language, writeMetadata(edit, ctx)),
  );

export const addAlias = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: EntityId,
  language: string,
  value: string,
  edit: AuthorizedExpectedRevision,
) =>
  guardedWrite(db, options, guard, context, (repo, ctx) =>
    repo.addAlias(id, language, value, writeMetadata(edit, ctx)),
  );

export const removeAlias = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: EntityId,
  language: string,
  ordinal: number,
  edit: AuthorizedExpectedRevision,
) =>
  guardedWrite(db, options, guard, context, (repo, ctx) =>
    repo.removeAlias(id, language, ordinal, writeMetadata(edit, ctx)),
  );

export const setSitelink = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: `Q${number}`,
  site: string,
  value: Sitelink,
  edit: AuthorizedExpectedRevision,
) =>
  guardedWrite(db, options, guard, context, (repo, ctx) =>
    repo.setSitelink(id, site, value, writeMetadata(edit, ctx)),
  );

export const removeSitelink = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: `Q${number}`,
  site: string,
  edit: AuthorizedExpectedRevision,
) =>
  guardedWrite(db, options, guard, context, (repo, ctx) =>
    repo.removeSitelink(id, site, writeMetadata(edit, ctx)),
  );

export const addStatement = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: EntityId,
  statement: Statement,
  edit: AuthorizedExpectedRevision,
) =>
  guardedWrite(db, options, guard, context, (repo, ctx) =>
    repo.addStatement(id, statement, writeMetadata(edit, ctx)),
  );

export const replaceStatement = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: EntityId,
  statementId: string,
  statement: Statement,
  edit: AuthorizedExpectedRevision,
) =>
  guardedWrite(db, options, guard, context, (repo, ctx) =>
    repo.replaceStatement(id, statementId, statement, writeMetadata(edit, ctx)),
  );

export const removeStatement = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: EntityId,
  statementId: string,
  edit: AuthorizedExpectedRevision,
) =>
  guardedWrite(db, options, guard, context, (repo, ctx) =>
    repo.removeStatement(id, statementId, writeMetadata(edit, ctx)),
  );

export const setStatementRank = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: EntityId,
  statementId: string,
  rank: Statement['rank'],
  text: string,
  edit: AuthorizedExpectedRevision,
) =>
  guardedWrite(db, options, guard, context, (repo, ctx) =>
    repo.setStatementRank(
      id,
      statementId,
      rank,
      text,
      writeMetadata(edit, ctx),
    ),
  );

export const addQualifier = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: EntityId,
  statementId: string,
  snak: Snak,
  text: string,
  edit: AuthorizedExpectedRevision,
) =>
  guardedWrite(db, options, guard, context, (repo, ctx) =>
    repo.addQualifier(id, statementId, snak, text, writeMetadata(edit, ctx)),
  );

export const removeQualifier = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: EntityId,
  statementId: string,
  property: PropertyId,
  ordinal: number,
  text: string,
  edit: AuthorizedExpectedRevision,
) =>
  guardedWrite(db, options, guard, context, (repo, ctx) =>
    repo.removeQualifier(
      id,
      statementId,
      property,
      ordinal,
      text,
      writeMetadata(edit, ctx),
    ),
  );

export const addReference = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: EntityId,
  statementId: string,
  reference: Reference,
  text: string,
  edit: AuthorizedExpectedRevision,
) =>
  guardedWrite(db, options, guard, context, (repo, ctx) =>
    repo.addReference(
      id,
      statementId,
      reference,
      text,
      writeMetadata(edit, ctx),
    ),
  );

export const removeReference = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: EntityId,
  statementId: string,
  hash: string,
  text: string,
  edit: AuthorizedExpectedRevision,
) =>
  guardedWrite(db, options, guard, context, (repo, ctx) =>
    repo.removeReference(id, statementId, hash, text, writeMetadata(edit, ctx)),
  );

export const replaceReference = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  guard: InstallationAuthorizationGuard,
  context: AuthorizationContext,
  id: EntityId,
  statementId: string,
  hash: string,
  reference: Reference,
  text: string,
  edit: AuthorizedExpectedRevision,
) =>
  guardedWrite(db, options, guard, context, (repo, ctx) =>
    repo.replaceReference(
      id,
      statementId,
      hash,
      reference,
      text,
      writeMetadata(edit, ctx),
    ),
  );
