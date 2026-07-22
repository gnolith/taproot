import type { D1DatabaseLike } from '@gnolith/diamond';
import { InvalidAuthorizationError } from './errors.js';
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

export * from './canonical.js';
export * from './authorization.js';
export * from './errors.js';
export * from './migrations.js';
export * from './rdf.js';
export * from './schema.js';
export * from './types.js';

function repository(
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
): TaprootRepository {
  if ('validators' in options)
    throw new InvalidAuthorizationError(
      'write options cannot install canonical-state validators',
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
export type TaprootWriteOptions = Omit<TaprootOptions, 'validators'> & {
  validators?: never;
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
  input?: CreateItemInput,
) => mutation(repository(db, options).createItem(input));

export const createProperty = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  input: CreatePropertyInput,
) => mutation(repository(db, options).createProperty(input));

export const importEntity = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  entity: WikibaseEntity,
  metadata?: EditMetadata,
) => mutation(repository(db, options).importEntity(entity, metadata));

export const importEntities = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  entities: Iterable<WikibaseEntity>,
  bulk?: BulkImportOptions,
) =>
  repository(db, options)
    .importEntities(entities, bulk)
    .then((result): BulkMutationReceipt => ({
      succeeded: result.succeeded.map(mutationReceipt),
      failed: result.failed,
    }));

export const applyCommands = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  id: EntityId,
  commands: readonly EntityCommand[],
  edit: ExpectedRevision,
) => mutation(repository(db, options).applyCommands(id, commands, edit));

export const replaceEntity = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  id: EntityId,
  entity: WikibaseEntity,
  edit: StatementRevisionEdit,
) => mutation(repository(db, options).replaceEntity(id, entity, edit));

export const revertEntity = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  id: EntityId,
  targetRevision: number,
  edit: StatementRevisionEdit,
) => mutation(repository(db, options).revertEntity(id, targetRevision, edit));

export const softDeleteEntity = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  id: EntityId,
  edit: ExpectedRevision,
) => mutation(repository(db, options).softDeleteEntity(id, edit));

export const restoreEntity = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  id: EntityId,
  edit: ExpectedRevision,
) => mutation(repository(db, options).restoreEntity(id, edit));

export const redirectEntity = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  id: EntityId,
  target: EntityId,
  edit: ExpectedRevision,
) => mutation(repository(db, options).redirectEntity(id, target, edit));

export const setLabel = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  id: EntityId,
  language: string,
  value: string,
  edit: ExpectedRevision,
) => mutation(repository(db, options).setLabel(id, language, value, edit));

export const removeLabel = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  id: EntityId,
  language: string,
  edit: ExpectedRevision,
) => mutation(repository(db, options).removeLabel(id, language, edit));

export const setDescription = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  id: EntityId,
  language: string,
  value: string,
  edit: ExpectedRevision,
) =>
  mutation(repository(db, options).setDescription(id, language, value, edit));

export const removeDescription = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  id: EntityId,
  language: string,
  edit: ExpectedRevision,
) => mutation(repository(db, options).removeDescription(id, language, edit));

export const addAlias = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  id: EntityId,
  language: string,
  value: string,
  edit: ExpectedRevision,
) => mutation(repository(db, options).addAlias(id, language, value, edit));

export const removeAlias = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  id: EntityId,
  language: string,
  ordinal: number,
  edit: ExpectedRevision,
) => mutation(repository(db, options).removeAlias(id, language, ordinal, edit));

export const setSitelink = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  id: `Q${number}`,
  site: string,
  value: Sitelink,
  edit: ExpectedRevision,
) => mutation(repository(db, options).setSitelink(id, site, value, edit));

export const removeSitelink = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  id: `Q${number}`,
  site: string,
  edit: ExpectedRevision,
) => mutation(repository(db, options).removeSitelink(id, site, edit));

export const addStatement = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  id: EntityId,
  statement: Statement,
  edit: ExpectedRevision,
) => mutation(repository(db, options).addStatement(id, statement, edit));

export const replaceStatement = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  id: EntityId,
  statementId: string,
  statement: Statement,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options).replaceStatement(id, statementId, statement, edit),
  );

export const removeStatement = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  id: EntityId,
  statementId: string,
  edit: ExpectedRevision,
) => mutation(repository(db, options).removeStatement(id, statementId, edit));

export const setStatementRank = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  id: EntityId,
  statementId: string,
  rank: Statement['rank'],
  text: string,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options).setStatementRank(id, statementId, rank, text, edit),
  );

export const addQualifier = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  id: EntityId,
  statementId: string,
  snak: Snak,
  text: string,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options).addQualifier(id, statementId, snak, text, edit),
  );

export const removeQualifier = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  id: EntityId,
  statementId: string,
  property: PropertyId,
  ordinal: number,
  text: string,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options).removeQualifier(
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
  id: EntityId,
  statementId: string,
  reference: Reference,
  text: string,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options).addReference(
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
  id: EntityId,
  statementId: string,
  hash: string,
  text: string,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options).removeReference(id, statementId, hash, text, edit),
  );

export const replaceReference = (
  db: D1DatabaseLike,
  options: TaprootWriteOptions,
  id: EntityId,
  statementId: string,
  hash: string,
  reference: Reference,
  text: string,
  edit: ExpectedRevision,
) =>
  mutation(
    repository(db, options).replaceReference(
      id,
      statementId,
      hash,
      reference,
      text,
      edit,
    ),
  );
