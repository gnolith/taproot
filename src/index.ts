import type { D1DatabaseLike } from '@gnolith/diamond';
import { InvalidAuthorizationError } from './errors.js';
import { canonicalizeTaprootBaseIri } from './migrations.js';
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
} from './repository.js';
export type {
  BulkImportOptions,
  CreateItemInput,
  CreatePropertyInput,
  ListAuditOptions,
  ListEntitiesOptions,
  SearchOptions,
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
} from './types.js';

export interface TaprootHostWriteCapability {
  readonly kind: 'taproot-host-write-v1';
}

const hostWriteCapabilities = new WeakMap<
  object,
  { db: D1DatabaseLike; baseIri: string }
>();

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

export interface MutationReceipt {
  entityId: EntityId;
  previousRevision: number | null;
  newRevision: number;
  status: 'committed';
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
  };
}

async function mutation(
  operation: Promise<WriteResult>,
): Promise<MutationReceipt> {
  return mutationReceipt(await operation);
}

export const createItem = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  input?: CreateItemInput,
) => mutation(repository(db, options, capability).createItem(input));

export const createProperty = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  input: CreatePropertyInput,
) => mutation(repository(db, options, capability).createProperty(input));

export const importEntity = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  entity: WikibaseEntity,
  metadata?: EditMetadata,
) =>
  mutation(repository(db, options, capability).importEntity(entity, metadata));

export const importEntities = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  entities: Iterable<WikibaseEntity>,
  bulk?: BulkImportOptions,
) =>
  repository(db, options, capability)
    .importEntities(entities, bulk)
    .then((result): BulkMutationReceipt => ({
      succeeded: result.succeeded.map(mutationReceipt),
      failed: result.failed,
    }));

export const applyCommands = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: EntityId,
  commands: readonly EntityCommand[],
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options, capability).applyCommands(id, commands, edit),
  );

export const replaceEntity = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: EntityId,
  entity: WikibaseEntity,
  edit: StatementRevisionEdit,
) =>
  mutation(repository(db, options, capability).replaceEntity(id, entity, edit));

export const revertEntity = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: EntityId,
  targetRevision: number,
  edit: StatementRevisionEdit,
) =>
  mutation(
    repository(db, options, capability).revertEntity(id, targetRevision, edit),
  );

export const softDeleteEntity = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: EntityId,
  edit: ExpectedRevision,
) => mutation(repository(db, options, capability).softDeleteEntity(id, edit));

export const restoreEntity = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: EntityId,
  edit: ExpectedRevision,
) => mutation(repository(db, options, capability).restoreEntity(id, edit));

export const redirectEntity = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: EntityId,
  target: EntityId,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options, capability).redirectEntity(id, target, edit),
  );

export const setLabel = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: EntityId,
  language: string,
  value: string,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options, capability).setLabel(id, language, value, edit),
  );

export const removeLabel = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: EntityId,
  language: string,
  edit: ExpectedRevision,
) =>
  mutation(repository(db, options, capability).removeLabel(id, language, edit));

export const setDescription = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: EntityId,
  language: string,
  value: string,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options, capability).setDescription(
      id,
      language,
      value,
      edit,
    ),
  );

export const removeDescription = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: EntityId,
  language: string,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options, capability).removeDescription(id, language, edit),
  );

export const addAlias = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: EntityId,
  language: string,
  value: string,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options, capability).addAlias(id, language, value, edit),
  );

export const removeAlias = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: EntityId,
  language: string,
  ordinal: number,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options, capability).removeAlias(
      id,
      language,
      ordinal,
      edit,
    ),
  );

export const setSitelink = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: `Q${number}`,
  site: string,
  value: Sitelink,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options, capability).setSitelink(id, site, value, edit),
  );

export const removeSitelink = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: `Q${number}`,
  site: string,
  edit: ExpectedRevision,
) =>
  mutation(repository(db, options, capability).removeSitelink(id, site, edit));

export const addStatement = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: EntityId,
  statement: Statement,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options, capability).addStatement(id, statement, edit),
  );

export const replaceStatement = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: EntityId,
  statementId: string,
  statement: Statement,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options, capability).replaceStatement(
      id,
      statementId,
      statement,
      edit,
    ),
  );

export const removeStatement = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: EntityId,
  statementId: string,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options, capability).removeStatement(id, statementId, edit),
  );

export const setStatementRank = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: EntityId,
  statementId: string,
  rank: Statement['rank'],
  text: string,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options, capability).setStatementRank(
      id,
      statementId,
      rank,
      text,
      edit,
    ),
  );

export const addQualifier = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: EntityId,
  statementId: string,
  snak: Snak,
  text: string,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options, capability).addQualifier(
      id,
      statementId,
      snak,
      text,
      edit,
    ),
  );

export const removeQualifier = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: EntityId,
  statementId: string,
  property: PropertyId,
  ordinal: number,
  text: string,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options, capability).removeQualifier(
      id,
      statementId,
      property,
      ordinal,
      text,
      edit,
    ),
  );

export const addReference = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: EntityId,
  statementId: string,
  reference: Reference,
  text: string,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options, capability).addReference(
      id,
      statementId,
      reference,
      text,
      edit,
    ),
  );

export const removeReference = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: EntityId,
  statementId: string,
  hash: string,
  text: string,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options, capability).removeReference(
      id,
      statementId,
      hash,
      text,
      edit,
    ),
  );

export const replaceReference = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  capability: TaprootHostWriteCapability,
  id: EntityId,
  statementId: string,
  hash: string,
  reference: Reference,
  text: string,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options, capability).replaceReference(
      id,
      statementId,
      hash,
      reference,
      text,
      edit,
    ),
  );
