import type { D1DatabaseLike } from '@gnolith/diamond';
export type { D1DatabaseLike } from '@gnolith/diamond';
import {
  TaprootRepository,
  type CreateItemInput,
  type CreatePropertyInput,
  type SearchOptions,
  type ListEntitiesOptions,
  type ListAuditOptions,
  type BulkImportOptions,
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
  TaprootOptions,
  WikibaseEntity,
} from './types.js';

export * from './canonical.js';
export * from './errors.js';
export * from './rdf.js';
export * from './repository.js';
export * from './schema.js';
export * from './types.js';

export function createTaproot(
  db: D1DatabaseLike,
  options: TaprootOptions,
): TaprootRepository {
  return new TaprootRepository(db, options);
}

export const getEntity = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
) => createTaproot(db, options).getEntity(id);

export const getEntityRevision = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  revision: number,
) => createTaproot(db, options).getEntityRevision(id, revision);

export const resolveEntity = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  maxDepth?: number,
) => createTaproot(db, options).resolveEntity(id, maxDepth);

export const listEntityRevisions = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  limit?: number,
) => createTaproot(db, options).listEntityRevisions(id, limit);

export const listEntityRevisionsPage = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  page?: { limit?: number; cursor?: string },
) => createTaproot(db, options).listEntityRevisionsPage(id, page);

export const searchEntities = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  query: string,
  search?: SearchOptions,
) => createTaproot(db, options).searchEntities(query, search);

export const searchEntitiesPage = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  query: string,
  search?: SearchOptions,
) => createTaproot(db, options).searchEntitiesPage(query, search);

export const listEntities = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  list?: ListEntitiesOptions,
) => createTaproot(db, options).listEntities(list);

export const getAuditEvent = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  eventId: string,
) => createTaproot(db, options).getAuditEvent(eventId);

export const listAuditEvents = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  list?: ListAuditOptions,
) => createTaproot(db, options).listAuditEvents(list);

export const createItem = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  input?: CreateItemInput,
) => createTaproot(db, options).createItem(input);

export const createProperty = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  input: CreatePropertyInput,
) => createTaproot(db, options).createProperty(input);

export const importEntity = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  entity: WikibaseEntity,
  metadata?: EditMetadata,
) => createTaproot(db, options).importEntity(entity, metadata);

export const importEntities = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  entities: Iterable<WikibaseEntity>,
  bulk?: BulkImportOptions,
) => createTaproot(db, options).importEntities(entities, bulk);

export const exportEntities = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  list?: ListEntitiesOptions,
) => createTaproot(db, options).exportEntities(list);

export const applyCommands = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  commands: readonly EntityCommand[],
  edit: ExpectedRevision,
) => createTaproot(db, options).applyCommands(id, commands, edit);

export const inspectEntityIntegrity = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
) => createTaproot(db, options).inspectEntityIntegrity(id);

export const inspectTaprootIntegrity = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  list?: ListEntitiesOptions,
) => createTaproot(db, options).inspectTaprootIntegrity(list);

export const verifyAuditChain = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
) => createTaproot(db, options).verifyAuditChain(id);

export const repairEntityProjection = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  metadata?: EditMetadata,
) => createTaproot(db, options).repairEntityProjection(id, metadata);

export const replaceEntity = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  entity: WikibaseEntity,
  edit: ExpectedRevision,
) => createTaproot(db, options).replaceEntity(id, entity, edit);

export const revertEntity = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  targetRevision: number,
  edit: ExpectedRevision,
) => createTaproot(db, options).revertEntity(id, targetRevision, edit);

export const softDeleteEntity = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  edit: ExpectedRevision,
) => createTaproot(db, options).softDeleteEntity(id, edit);

export const restoreEntity = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  edit: ExpectedRevision,
) => createTaproot(db, options).restoreEntity(id, edit);

export const redirectEntity = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  target: EntityId,
  edit: ExpectedRevision,
) => createTaproot(db, options).redirectEntity(id, target, edit);

export const setLabel = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  language: string,
  value: string,
  edit: ExpectedRevision,
) => createTaproot(db, options).setLabel(id, language, value, edit);

export const removeLabel = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  language: string,
  edit: ExpectedRevision,
) => createTaproot(db, options).removeLabel(id, language, edit);

export const setDescription = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  language: string,
  value: string,
  edit: ExpectedRevision,
) => createTaproot(db, options).setDescription(id, language, value, edit);

export const removeDescription = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  language: string,
  edit: ExpectedRevision,
) => createTaproot(db, options).removeDescription(id, language, edit);

export const addAlias = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  language: string,
  value: string,
  edit: ExpectedRevision,
) => createTaproot(db, options).addAlias(id, language, value, edit);

export const removeAlias = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  language: string,
  ordinal: number,
  edit: ExpectedRevision,
) => createTaproot(db, options).removeAlias(id, language, ordinal, edit);

export const setSitelink = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: `Q${number}`,
  site: string,
  value: Sitelink,
  edit: ExpectedRevision,
) => createTaproot(db, options).setSitelink(id, site, value, edit);

export const removeSitelink = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: `Q${number}`,
  site: string,
  edit: ExpectedRevision,
) => createTaproot(db, options).removeSitelink(id, site, edit);

export const addStatement = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  statement: Statement,
  edit: ExpectedRevision,
) => createTaproot(db, options).addStatement(id, statement, edit);

export const replaceStatement = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  statementId: string,
  statement: Statement,
  edit: ExpectedRevision,
) =>
  createTaproot(db, options).replaceStatement(id, statementId, statement, edit);

export const removeStatement = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  statementId: string,
  edit: ExpectedRevision,
) => createTaproot(db, options).removeStatement(id, statementId, edit);

export const setStatementRank = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  statementId: string,
  rank: Statement['rank'],
  edit: ExpectedRevision,
) => createTaproot(db, options).setStatementRank(id, statementId, rank, edit);

export const addQualifier = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  statementId: string,
  snak: Snak,
  edit: ExpectedRevision,
) => createTaproot(db, options).addQualifier(id, statementId, snak, edit);

export const removeQualifier = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  statementId: string,
  property: PropertyId,
  ordinal: number,
  edit: ExpectedRevision,
) =>
  createTaproot(db, options).removeQualifier(
    id,
    statementId,
    property,
    ordinal,
    edit,
  );

export const addReference = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  statementId: string,
  reference: Reference,
  edit: ExpectedRevision,
) => createTaproot(db, options).addReference(id, statementId, reference, edit);

export const removeReference = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  statementId: string,
  hash: string,
  edit: ExpectedRevision,
) => createTaproot(db, options).removeReference(id, statementId, hash, edit);

export const replaceReference = (
  db: D1DatabaseLike,
  options: TaprootOptions,
  id: EntityId,
  statementId: string,
  hash: string,
  reference: Reference,
  edit: ExpectedRevision,
) =>
  createTaproot(db, options).replaceReference(
    id,
    statementId,
    hash,
    reference,
    edit,
  );
