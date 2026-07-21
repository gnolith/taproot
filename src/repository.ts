import {
  QuadPatchConflictError,
  encodeTerm,
  decodeTerm,
  prepareQuadPatch,
  type SqliteDatabaseLike,
  type SqlitePreparedStatementLike,
} from '@gnolith/diamond';
import type * as RDF from '@rdfjs/types';
import { DataFactory } from 'rdf-data-factory';
import {
  cloneEntity,
  assertAuthoredStatementText,
  entityNumericId,
  exportEntityJson,
  MAX_ENTITY_BYTES,
  parseEntityJson,
  validateEntity,
  validateSnak,
} from './canonical.js';
import {
  EntityAlreadyExistsError,
  EntityNotFoundError,
  InvalidEntityError,
  InvalidStatementError,
  InvalidCursorError,
  BulkLimitError,
  PropertyDatatypeMismatchError,
  PropertyNotFoundError,
  QuadPatchTooLargeError,
  RevisionConflictError,
  SchemaMismatchError,
} from './errors.js';
import { buildEntityQuads } from './rdf.js';
import { withoutTrailingSlashes } from './iri.js';
import { canonicalizeTaprootBaseIri } from './migrations.js';
import { TAPROOT_RDF_VERSION } from './schema.js';
import type {
  AliasMap,
  AuditEvent,
  AuditEventType,
  Attribution,
  BulkImportResult,
  EditMetadata,
  EntityDatatype,
  EntityCommand,
  EntityId,
  EntityIntegrityReport,
  EntityListEntry,
  EntityType,
  ExpectedRevision,
  Item,
  LanguageMap,
  Property,
  PropertyId,
  Reference,
  ResolvedEntity,
  RevisionEntry,
  Page,
  SearchResult,
  Sitelink,
  Snak,
  Statement,
  StatementRevisionEdit,
  StoredEntity,
  TaprootOptions,
  WikibaseEntity,
  WriteResult,
} from './types.js';

interface EntityRow {
  entity_json: string;
  deleted_at: string | null;
  redirect_to: string | null;
  content_hash?: string | null;
}

interface RevisionRow {
  entity_id: EntityId;
  revision: number;
  entity_json: string;
  actor: string | null;
  attribution_json: string | null;
  edit_summary: string | null;
  tags_json: string;
  event_id: string;
  content_hash: string;
  parent_hash: string | null;
  deleted_at: string | null;
  redirect_to: EntityId | null;
  created_at: string;
}

interface AuditRow {
  event_sequence: number;
  event_id: string;
  entity_id: EntityId;
  revision: number;
  event_type: AuditEventType;
  attribution_json: string | null;
  edit_summary: string | null;
  tags_json: string;
  request_id: string | null;
  content_hash: string;
  parent_hash: string | null;
  details_json: string;
  created_at: string;
}

interface Lifecycle {
  deletedAt: string | null;
  redirectTo: EntityId | null;
}

interface WriteContext {
  eventId: string;
  contentHash: string;
  parentHash: string | null;
  eventType: AuditEventType;
  attribution: Attribution | null;
  tags: string[];
  createdAt: string;
  lifecycle: Lifecycle;
}

export interface CreateItemInput extends EditMetadata {
  id?: `Q${number}`;
  labels?: LanguageMap;
  descriptions?: LanguageMap;
  aliases?: AliasMap;
  claims?: Record<PropertyId, Statement[]>;
  sitelinks?: Record<string, Sitelink>;
}

export interface CreatePropertyInput extends EditMetadata {
  id?: `P${number}`;
  datatype: EntityDatatype;
  labels?: LanguageMap;
  descriptions?: LanguageMap;
  aliases?: AliasMap;
  claims?: Record<PropertyId, Statement[]>;
}

export interface SearchOptions {
  language?: string;
  limit?: number;
  includeDeleted?: boolean;
  cursor?: string;
}

export interface ListEntitiesOptions {
  type?: EntityType;
  includeDeleted?: boolean;
  limit?: number;
  cursor?: string;
}

export interface ListAuditOptions {
  entityId?: EntityId;
  requestId?: string;
  type?: AuditEventType;
  attributionId?: string;
  tag?: string;
  limit?: number;
  cursor?: string;
}

export interface BulkImportOptions {
  metadata?: EditMetadata;
  continueOnError?: boolean;
  mode?: 'create' | 'upsert';
}

export class TaprootRepository {
  readonly #db: SqliteDatabaseLike;
  readonly #options: Required<
    Pick<
      TaprootOptions,
      | 'baseIri'
      | 'mappingVersion'
      | 'maxEntityBytes'
      | 'maxBulkEntities'
      | 'clock'
      | 'createId'
      | 'validators'
      | 'requireAttribution'
    >
  > &
    Pick<TaprootOptions, 'factory' | 'observe'>;

  constructor(db: SqliteDatabaseLike, options: TaprootOptions) {
    if (
      options.mappingVersion !== undefined &&
      options.mappingVersion !== TAPROOT_RDF_VERSION
    ) {
      throw new SchemaMismatchError(
        `RDF mapping version ${options.mappingVersion} is not supported`,
      );
    }
    const baseIri = canonicalizeTaprootBaseIri(options.baseIri);
    this.#db = db;
    this.#options = {
      baseIri,
      mappingVersion: options.mappingVersion ?? TAPROOT_RDF_VERSION,
      maxEntityBytes: options.maxEntityBytes ?? MAX_ENTITY_BYTES,
      maxBulkEntities: options.maxBulkEntities ?? 100,
      clock: options.clock ?? (() => new Date()),
      createId: options.createId ?? (() => crypto.randomUUID()),
      validators: options.validators ?? [],
      requireAttribution: options.requireAttribution ?? false,
      ...(options.observe ? { observe: options.observe } : {}),
      ...(options.factory ? { factory: options.factory } : {}),
    };
  }

  async getEntity(id: EntityId): Promise<StoredEntity> {
    const row = await this.#loadRow(id);
    if (!row) throw new EntityNotFoundError(`Entity ${id} was not found`);
    return storedFromRow(row);
  }

  async resolveEntity(id: EntityId, maxDepth = 100): Promise<ResolvedEntity> {
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 1000)
      throw new RangeError('maxDepth must be an integer from 0 through 1000');
    const redirects: EntityId[] = [];
    const seen = new Set<EntityId>();
    let current = id;
    for (;;) {
      if (seen.has(current))
        throw new InvalidEntityError(`Redirect cycle includes ${current}`);
      seen.add(current);
      const stored = await this.getEntity(current);
      if (!stored.redirectTo)
        return { ...stored, requestedId: id, resolvedId: current, redirects };
      if (redirects.length >= maxDepth)
        throw new InvalidEntityError(`Redirect depth exceeds ${maxDepth}`);
      redirects.push(stored.redirectTo);
      current = stored.redirectTo;
    }
  }

  async getEntityRevision(
    id: EntityId,
    revision: number,
  ): Promise<RevisionEntry> {
    const result = await this.#db
      .prepare(
        `SELECT entity_id, revision, entity_json, actor, attribution_json, edit_summary,
           tags_json, event_id, content_hash, parent_hash, deleted_at, redirect_to, created_at
         FROM taproot_entity_revisions WHERE entity_id = ? AND revision = ?`,
      )
      .bind(id, revision)
      .all<RevisionRow>();
    const row = result.results[0];
    if (!row)
      throw new EntityNotFoundError(`Revision ${id}@${revision} was not found`);
    return revisionFromRow(row);
  }

  async listEntityRevisions(
    id: EntityId,
    limit = 50,
  ): Promise<RevisionEntry[]> {
    assertLimit(limit);
    const result = await this.#db
      .prepare(
        `SELECT entity_id, revision, entity_json, actor, attribution_json, edit_summary,
           tags_json, event_id, content_hash, parent_hash, deleted_at, redirect_to, created_at
         FROM taproot_entity_revisions WHERE entity_id = ?
         ORDER BY revision DESC LIMIT ?`,
      )
      .bind(id, limit)
      .all<RevisionRow>();
    return result.results.map(revisionFromRow);
  }

  async listEntityRevisionsPage(
    id: EntityId,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<Page<RevisionEntry>> {
    const limit = options.limit ?? 50;
    assertLimit(limit);
    const before = options.cursor
      ? decodeCursor<{ revision: number }>(options.cursor).revision
      : Number.MAX_SAFE_INTEGER;
    const result = await this.#db
      .prepare(
        `SELECT entity_id, revision, entity_json, actor, attribution_json, edit_summary,
           tags_json, event_id, content_hash, parent_hash, deleted_at, redirect_to, created_at
         FROM taproot_entity_revisions WHERE entity_id = ? AND revision < ?
         ORDER BY revision DESC LIMIT ?`,
      )
      .bind(id, before, limit + 1)
      .all<RevisionRow>();
    return page(result.results.map(revisionFromRow), limit, (entry) => ({
      revision: entry.revision,
    }));
  }

  async listEntities(
    options: ListEntitiesOptions = {},
  ): Promise<Page<EntityListEntry>> {
    const limit = options.limit ?? 50;
    assertLimit(limit);
    const after = options.cursor
      ? decodeCursor<{ entityType: EntityType; numericId: number }>(
          options.cursor,
        )
      : null;
    const result = await this.#db
      .prepare(
        `SELECT entity_id, entity_json, deleted_at, redirect_to FROM taproot_entities
         WHERE (? IS NULL OR entity_type > ? OR
           (entity_type = ? AND CAST(substr(entity_id, 2) AS INTEGER) > ?))
           AND (? IS NULL OR entity_type = ?)
           AND (? = 1 OR deleted_at IS NULL)
         ORDER BY entity_type, CAST(substr(entity_id, 2) AS INTEGER) LIMIT ?`,
      )
      .bind(
        after?.entityType ?? null,
        after?.entityType ?? null,
        after?.entityType ?? null,
        after?.numericId ?? 0,
        options.type ?? null,
        options.type ?? null,
        options.includeDeleted ? 1 : 0,
        limit + 1,
      )
      .all<EntityRow & { entity_id: EntityId }>();
    return page(
      result.results.map((row) => ({
        entityId: row.entity_id,
        ...storedFromRow(row),
      })),
      limit,
      (entry) => ({
        entityType: entry.entity.type,
        numericId: entityNumericId(entry.entityId),
      }),
    );
  }

  async getAuditEvent(eventId: string): Promise<AuditEvent> {
    const result = await this.#db
      .prepare(
        `SELECT rowid AS event_sequence, * FROM taproot_audit_events WHERE event_id = ?`,
      )
      .bind(eventId)
      .all<AuditRow>();
    const row = result.results[0];
    if (!row)
      throw new EntityNotFoundError(`Audit event ${eventId} was not found`);
    return auditFromRow(row);
  }

  async listAuditEvents(
    options: ListAuditOptions = {},
  ): Promise<Page<AuditEvent>> {
    const limit = options.limit ?? 50;
    assertLimit(limit);
    const before = options.cursor
      ? decodeCursor<{ sequence: number }>(options.cursor).sequence
      : Number.MAX_SAFE_INTEGER;
    const result = await this.#db
      .prepare(
        `SELECT rowid AS event_sequence, * FROM taproot_audit_events
         WHERE (? IS NULL OR entity_id = ?) AND (? IS NULL OR request_id = ?)
           AND (? IS NULL OR event_type = ?)
           AND (? IS NULL OR json_extract(attribution_json, '$.id') = ?)
           AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(tags_json) WHERE value = ?))
           AND rowid < ?
         ORDER BY rowid DESC LIMIT ?`,
      )
      .bind(
        options.entityId ?? null,
        options.entityId ?? null,
        options.requestId ?? null,
        options.requestId ?? null,
        options.type ?? null,
        options.type ?? null,
        options.attributionId ?? null,
        options.attributionId ?? null,
        options.tag ?? null,
        options.tag ?? null,
        before,
        limit + 1,
      )
      .all<AuditRow>();
    return page(result.results.map(auditFromRow), limit, (event) => ({
      sequence: event.sequence,
    }));
  }

  async searchEntities(
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    const limit = options.limit ?? 20;
    assertLimit(limit);
    const escaped = query.replace(/[\\%_]/gu, '\\$&');
    const result = await this.#db
      .prepare(
        `SELECT t.entity_id, e.entity_type, t.language, t.term_type, t.value
         FROM taproot_terms t JOIN taproot_entities e ON e.entity_id = t.entity_id
         WHERE t.value LIKE ? ESCAPE '\\' COLLATE NOCASE
           AND (? IS NULL OR t.language = ?)
           AND (? = 1 OR e.deleted_at IS NULL)
         ORDER BY CASE WHEN t.value = ? COLLATE NOCASE THEN 0 ELSE 1 END,
           t.value COLLATE NOCASE, t.entity_id
         LIMIT ?`,
      )
      .bind(
        `%${escaped}%`,
        options.language ?? null,
        options.language ?? null,
        options.includeDeleted ? 1 : 0,
        query,
        limit,
      )
      .all<{
        entity_id: EntityId;
        entity_type: 'item' | 'property';
        language: string;
        term_type: SearchResult['termType'];
        value: string;
      }>();
    return result.results.map((row) => ({
      entityId: row.entity_id,
      entityType: row.entity_type,
      language: row.language,
      termType: row.term_type,
      value: row.value,
    }));
  }

  async searchEntitiesPage(
    query: string,
    options: SearchOptions = {},
  ): Promise<Page<SearchResult>> {
    const limit = options.limit ?? 20;
    assertLimit(limit);
    const offset = options.cursor
      ? decodeCursor<{ offset: number }>(options.cursor).offset
      : 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new InvalidCursorError('Search cursor offset is invalid');
    const escaped = query.replace(/[\\%_]/gu, '\\$&');
    const result = await this.#db
      .prepare(
        `SELECT t.entity_id, e.entity_type, t.language, t.term_type, t.value
       FROM taproot_terms t JOIN taproot_entities e ON e.entity_id = t.entity_id
       WHERE t.value LIKE ? ESCAPE '\\' COLLATE NOCASE
         AND (? IS NULL OR t.language = ?) AND (? = 1 OR e.deleted_at IS NULL)
       ORDER BY CASE WHEN t.value = ? COLLATE NOCASE THEN 0 ELSE 1 END,
         t.value COLLATE NOCASE, t.entity_id, t.language, t.term_type, t.ordinal
       LIMIT ? OFFSET ?`,
      )
      .bind(
        `%${escaped}%`,
        options.language ?? null,
        options.language ?? null,
        options.includeDeleted ? 1 : 0,
        query,
        limit + 1,
        offset,
      )
      .all<{
        entity_id: EntityId;
        entity_type: EntityType;
        language: string;
        term_type: SearchResult['termType'];
        value: string;
      }>();
    const items = result.results.slice(0, limit).map((row) => ({
      entityId: row.entity_id,
      entityType: row.entity_type,
      language: row.language,
      termType: row.term_type,
      value: row.value,
    }));
    return {
      items,
      cursor:
        result.results.length > limit
          ? encodeCursor({ offset: offset + limit })
          : null,
    };
  }

  async createItem(input: CreateItemInput = {}): Promise<WriteResult> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = input.id ?? ((await this.#nextId('item')) as `Q${number}`);
      const entity: Item = {
        id,
        type: 'item',
        labels: structuredClone(input.labels ?? {}),
        descriptions: structuredClone(input.descriptions ?? {}),
        aliases: structuredClone(input.aliases ?? {}),
        claims: structuredClone(input.claims ?? {}),
        sitelinks: structuredClone(input.sitelinks ?? {}),
        lastrevid: 1,
        modified: this.#options.clock().toISOString(),
      };
      try {
        return await this.#create(
          entity,
          input,
          input.id === undefined,
          'create',
        );
      } catch (cause) {
        if (
          input.id !== undefined ||
          !(
            cause instanceof RevisionConflictError ||
            cause instanceof EntityAlreadyExistsError
          )
        ) {
          throw cause;
        }
      }
    }
    throw new RevisionConflictError(
      'Could not allocate an Item id after 8 attempts',
    );
  }

  async createProperty(input: CreatePropertyInput): Promise<WriteResult> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = input.id ?? ((await this.#nextId('property')) as `P${number}`);
      const entity: Property = {
        id,
        type: 'property',
        datatype: input.datatype,
        labels: structuredClone(input.labels ?? {}),
        descriptions: structuredClone(input.descriptions ?? {}),
        aliases: structuredClone(input.aliases ?? {}),
        claims: structuredClone(input.claims ?? {}),
        lastrevid: 1,
        modified: this.#options.clock().toISOString(),
      };
      try {
        return await this.#create(
          entity,
          input,
          input.id === undefined,
          'create',
        );
      } catch (cause) {
        if (
          input.id !== undefined ||
          !(
            cause instanceof RevisionConflictError ||
            cause instanceof EntityAlreadyExistsError
          )
        ) {
          throw cause;
        }
      }
    }
    throw new RevisionConflictError(
      'Could not allocate a Property id after 8 attempts',
    );
  }

  async importEntity(
    entity: WikibaseEntity,
    metadata: EditMetadata = {},
  ): Promise<WriteResult> {
    const imported = cloneEntity(entity);
    imported.lastrevid = Math.max(1, imported.lastrevid);
    return this.#create(imported, metadata, false, 'import');
  }

  async replaceEntity(
    id: EntityId,
    replacement: WikibaseEntity,
    edit: StatementRevisionEdit,
  ): Promise<WriteResult> {
    if (replacement.id !== id)
      throw new InvalidEntityError('Replacement entity id cannot change');
    return this.#mutate(
      id,
      edit,
      () =>
        resupplyStatementTexts(cloneEntity(replacement), edit.statementTexts),
      undefined,
      'update',
    );
  }

  async revertEntity(
    id: EntityId,
    targetRevision: number,
    edit: StatementRevisionEdit,
  ): Promise<WriteResult> {
    const target = await this.getEntityRevision(id, targetRevision);
    return this.#mutate(
      id,
      edit,
      () =>
        resupplyStatementTexts(cloneEntity(target.entity), edit.statementTexts),
      { deletedAt: target.deletedAt, redirectTo: target.redirectTo },
      'revert',
    );
  }

  async softDeleteEntity(
    id: EntityId,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    return this.#mutate(
      id,
      edit,
      (entity) => entity,
      {
        deletedAt: this.#options.clock().toISOString(),
        redirectTo: null,
      },
      'delete',
    );
  }

  async restoreEntity(
    id: EntityId,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    return this.#mutate(
      id,
      edit,
      (entity) => entity,
      {
        deletedAt: null,
        redirectTo: null,
      },
      'restore',
    );
  }

  async redirectEntity(
    id: EntityId,
    target: EntityId,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    if (id === target)
      throw new InvalidEntityError('An entity cannot redirect to itself');
    const source = await this.getEntity(id);
    const targetEntity = await this.getEntity(target);
    if (source.entity.type !== targetEntity.entity.type)
      throw new InvalidEntityError(
        'Redirect source and target must have the same entity type',
      );
    if (targetEntity.deletedAt)
      throw new InvalidEntityError(
        'An entity cannot redirect to a deleted target',
      );
    const seen = new Set<EntityId>([id]);
    let cursor: EntityId | null = target;
    for (let depth = 0; cursor && depth < 100; depth += 1) {
      if (seen.has(cursor))
        throw new InvalidEntityError('Redirect would create a cycle');
      seen.add(cursor);
      cursor = (await this.getEntity(cursor)).redirectTo;
    }
    if (cursor)
      throw new InvalidEntityError('Redirect chain exceeds 100 entities');
    return this.#mutate(
      id,
      edit,
      (entity) => entity,
      {
        deletedAt: null,
        redirectTo: target,
      },
      'redirect',
    );
  }

  async setLabel(
    id: EntityId,
    language: string,
    value: string,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    return this.#mutate(id, edit, (entity) => {
      entity.labels[language] = { language, value };
      return entity;
    });
  }

  async removeLabel(
    id: EntityId,
    language: string,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    return this.#mutate(id, edit, (entity) => {
      delete entity.labels[language];
      return entity;
    });
  }

  async setDescription(
    id: EntityId,
    language: string,
    value: string,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    return this.#mutate(id, edit, (entity) => {
      entity.descriptions[language] = { language, value };
      return entity;
    });
  }

  async removeDescription(
    id: EntityId,
    language: string,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    return this.#mutate(id, edit, (entity) => {
      delete entity.descriptions[language];
      return entity;
    });
  }

  async addAlias(
    id: EntityId,
    language: string,
    value: string,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    return this.#mutate(id, edit, (entity) => {
      entity.aliases[language] ??= [];
      entity.aliases[language].push({ language, value });
      return entity;
    });
  }

  async removeAlias(
    id: EntityId,
    language: string,
    ordinal: number,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    return this.#mutate(id, edit, (entity) => {
      const aliases = entity.aliases[language];
      if (!aliases?.[ordinal])
        throw new InvalidEntityError(
          `Alias ${language}[${ordinal}] does not exist`,
        );
      aliases.splice(ordinal, 1);
      if (!aliases.length) delete entity.aliases[language];
      return entity;
    });
  }

  async setSitelink(
    id: `Q${number}`,
    site: string,
    value: Sitelink,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    return this.#mutate(id, edit, (entity) => {
      if (entity.type !== 'item')
        throw new InvalidEntityError('Properties cannot have sitelinks');
      entity.sitelinks[site] = { ...structuredClone(value), site };
      return entity;
    });
  }

  async removeSitelink(
    id: `Q${number}`,
    site: string,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    return this.#mutate(id, edit, (entity) => {
      if (entity.type !== 'item')
        throw new InvalidEntityError('Properties cannot have sitelinks');
      delete entity.sitelinks[site];
      return entity;
    });
  }

  async addStatement(
    id: EntityId,
    statement: Statement,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    assertAuthoredStatementText(statement.text, statement.id);
    return this.#mutate(id, edit, (entity) => {
      const property = statement.mainsnak.property;
      entity.claims[property] ??= [];
      entity.claims[property].push(structuredClone(statement));
      return entity;
    });
  }

  async replaceStatement(
    id: EntityId,
    statementId: string,
    statement: Statement,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    assertAuthoredStatementText(statement.text, statement.id);
    return this.#mutate(id, edit, (entity) => {
      const located = locateStatement(entity, statementId);
      located.statements.splice(located.index, 1);
      if (!located.statements.length) delete entity.claims[located.property];
      const target = statement.mainsnak.property;
      entity.claims[target] ??= [];
      entity.claims[target].push(structuredClone(statement));
      return entity;
    });
  }

  async removeStatement(
    id: EntityId,
    statementId: string,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    return this.#mutate(id, edit, (entity) => {
      const located = locateStatement(entity, statementId);
      located.statements.splice(located.index, 1);
      if (!located.statements.length) delete entity.claims[located.property];
      return entity;
    });
  }

  async setStatementRank(
    id: EntityId,
    statementId: string,
    rank: Statement['rank'],
    text: string,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    assertAuthoredStatementText(text, statementId);
    return this.#mutate(id, edit, (entity) => {
      const statement = locateStatement(entity, statementId).statement;
      statement.rank = rank;
      statement.text = text;
      return entity;
    });
  }

  async addQualifier(
    id: EntityId,
    statementId: string,
    snak: Snak,
    text: string,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    assertAuthoredStatementText(text, statementId);
    validateSnak(snak);
    return this.#mutate(id, edit, (entity) => {
      const statement = locateStatement(entity, statementId).statement;
      statement.text = text;
      const property = snak.property;
      if (!statement.qualifiers[property]) {
        statement.qualifiers[property] = [];
        statement['qualifiers-order'].push(property);
      }
      statement.qualifiers[property].push(structuredClone(snak));
      return entity;
    });
  }

  async removeQualifier(
    id: EntityId,
    statementId: string,
    property: PropertyId,
    ordinal: number,
    text: string,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    assertAuthoredStatementText(text, statementId);
    return this.#mutate(id, edit, (entity) => {
      const statement = locateStatement(entity, statementId).statement;
      statement.text = text;
      const snaks = statement.qualifiers[property];
      if (!snaks?.[ordinal])
        throw new InvalidStatementError('Qualifier does not exist');
      snaks.splice(ordinal, 1);
      if (!snaks.length) {
        delete statement.qualifiers[property];
        statement['qualifiers-order'] = statement['qualifiers-order'].filter(
          (id) => id !== property,
        );
      }
      return entity;
    });
  }

  async addReference(
    id: EntityId,
    statementId: string,
    reference: Reference,
    text: string,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    assertAuthoredStatementText(text, statementId);
    return this.#mutate(id, edit, (entity) => {
      const statement = locateStatement(entity, statementId).statement;
      statement.text = text;
      statement.references.push(structuredClone(reference));
      return entity;
    });
  }

  async removeReference(
    id: EntityId,
    statementId: string,
    hash: string,
    text: string,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    assertAuthoredStatementText(text, statementId);
    return this.#mutate(id, edit, (entity) => {
      const statement = locateStatement(entity, statementId).statement;
      statement.text = text;
      const references = statement.references;
      const index = references.findIndex(
        (reference) => reference.hash === hash,
      );
      if (index < 0)
        throw new InvalidStatementError(`Reference ${hash} does not exist`);
      references.splice(index, 1);
      return entity;
    });
  }

  async replaceReference(
    id: EntityId,
    statementId: string,
    hash: string,
    reference: Reference,
    text: string,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    assertAuthoredStatementText(text, statementId);
    return this.#mutate(id, edit, (entity) => {
      const statement = locateStatement(entity, statementId).statement;
      statement.text = text;
      const references = statement.references;
      const index = references.findIndex((item) => item.hash === hash);
      if (index < 0)
        throw new InvalidStatementError(`Reference ${hash} does not exist`);
      references[index] = structuredClone(reference);
      return entity;
    });
  }

  async importEntities(
    entities: Iterable<WikibaseEntity>,
    options: BulkImportOptions = {},
  ): Promise<BulkImportResult> {
    const values = [...entities];
    if (values.length > this.#options.maxBulkEntities) {
      throw new BulkLimitError(
        `Bulk import contains ${values.length} entities; maximum is ${this.#options.maxBulkEntities}`,
      );
    }
    const succeeded = new Map<number, WriteResult>();
    const failed: BulkImportResult['failed'] = [];
    let pending = values
      .map((entity, index) => ({ entity, index }))
      .sort(
        (a, b) =>
          Number(a.entity.type !== 'property') -
          Number(b.entity.type !== 'property'),
      );
    while (pending.length) {
      const deferred: typeof pending = [];
      let progress = false;
      for (const entry of pending) {
        try {
          succeeded.set(
            entry.index,
            await this.#importOne(entry.entity, options),
          );
          progress = true;
        } catch (error) {
          if (error instanceof PropertyNotFoundError) {
            deferred.push(entry);
            continue;
          }
          failed.push({
            index: entry.index,
            entityId: entry.entity.id,
            error: toError(error),
          });
          if (!options.continueOnError)
            return {
              succeeded: [...succeeded.entries()]
                .sort(([a], [b]) => a - b)
                .map(([, item]) => item),
              failed,
            };
        }
      }
      if (!deferred.length) break;
      if (!progress) {
        for (const entry of options.continueOnError
          ? deferred
          : deferred.slice(0, 1)) {
          failed.push({
            index: entry.index,
            entityId: entry.entity.id,
            error: new PropertyNotFoundError(
              `Entity ${entry.entity.id} has unresolved Property dependencies`,
            ),
          });
        }
        break;
      }
      pending = deferred;
    }
    return {
      succeeded: [...succeeded.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, item]) => item),
      failed: failed.sort((a, b) => a.index - b.index),
    };
  }

  async #importOne(
    entity: WikibaseEntity,
    options: BulkImportOptions,
  ): Promise<WriteResult> {
    if (options.mode === 'upsert') {
      try {
        const current = await this.getEntity(entity.id);
        return await this.replaceEntity(entity.id, entity, {
          expectedRevision: current.entity.lastrevid,
          statementTexts: authoredStatementTexts(entity),
          ...options.metadata,
        });
      } catch (error) {
        if (!(error instanceof EntityNotFoundError)) throw error;
      }
    }
    return this.importEntity(entity, options.metadata);
  }

  async applyCommands(
    id: EntityId,
    commands: readonly EntityCommand[],
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    if (!commands.length)
      throw new InvalidEntityError('At least one command is required');
    if (commands.length > 100)
      throw new BulkLimitError('An edit may contain at most 100 commands');
    return this.#mutate(id, edit, (entity) => {
      for (const command of commands) applyEntityCommand(entity, command);
      return entity;
    });
  }

  async exportEntities(options: ListEntitiesOptions = {}): Promise<string> {
    const lines: string[] = [];
    let cursor = options.cursor;
    do {
      const current = await this.listEntities({
        ...options,
        ...(cursor ? { cursor } : {}),
        limit: options.limit ?? 100,
      });
      lines.push(
        ...current.items.map(({ entity }) =>
          exportEntityJson(entity, this.#options.maxEntityBytes),
        ),
      );
      cursor = current.cursor ?? undefined;
    } while (cursor);
    return lines.length ? `${lines.join('\n')}\n` : '';
  }

  async inspectEntityIntegrity(id: EntityId): Promise<EntityIntegrityReport> {
    const stored = await this.getEntity(id);
    const entity = stored.entity;
    const issues: EntityIntegrityReport['issues'] = [];
    const revisionResult = await this.#db
      .prepare(
        `SELECT entity_id, revision, entity_json, actor, attribution_json, edit_summary,
          tags_json, event_id, content_hash, parent_hash, deleted_at, redirect_to, created_at
         FROM taproot_entity_revisions WHERE entity_id = ? AND revision = ?`,
      )
      .bind(id, entity.lastrevid)
      .all<RevisionRow>();
    const revision = revisionResult.results[0];
    if (!revision) {
      issues.push({
        code: 'current-revision-mismatch',
        message: `Current revision ${entity.lastrevid} is missing`,
      });
    } else {
      const currentJson = exportEntityJson(
        entity,
        this.#options.maxEntityBytes,
      );
      if (revision.entity_json !== currentJson)
        issues.push({
          code: 'revision-json-mismatch',
          message: 'Current entity JSON differs from its immutable revision',
        });
      if (
        revision.content_hash !==
        (await revisionContentHash(revision.entity_json, {
          deletedAt: revision.deleted_at,
          redirectTo: revision.redirect_to,
        }))
      )
        issues.push({
          code: 'content-hash-mismatch',
          message: 'Revision content hash is invalid',
        });
      const audit = await this.#db
        .prepare(
          `SELECT 1 AS found FROM taproot_audit_events WHERE event_id = ?`,
        )
        .bind(revision.event_id)
        .all<{ found: number }>();
      if (!audit.results.length)
        issues.push({
          code: 'audit-event-missing',
          message: `Audit event ${revision.event_id} is missing`,
        });
    }
    const actualTerms = await this.#db
      .prepare(
        `SELECT language, term_type, value, ordinal FROM taproot_terms WHERE entity_id = ? ORDER BY language, term_type, ordinal`,
      )
      .bind(id)
      .all<Record<string, unknown>>();
    const expectedTerms = terms(entity)
      .map(({ language, termType, value, ordinal }) => ({
        language,
        term_type: termType,
        value,
        ordinal,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const normalizedActual = [...actualTerms.results].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
    if (JSON.stringify(normalizedActual) !== JSON.stringify(expectedTerms))
      issues.push({
        code: 'term-projection-mismatch',
        message: 'Search term projection differs from canonical JSON',
      });
    const expectedQuads = this.#lifecycleQuads(entity, {
      deletedAt: stored.deletedAt,
      redirectTo: stored.redirectTo,
    });
    const actualQuads = await this.#ownedQuads(id);
    if (!sameQuads(actualQuads, expectedQuads))
      issues.push({
        code: 'rdf-projection-mismatch',
        message: 'RDF projection differs from canonical JSON',
      });
    return {
      entityId: id,
      revision: entity.lastrevid,
      valid: issues.length === 0,
      issues,
    };
  }

  async inspectTaprootIntegrity(
    options: ListEntitiesOptions = {},
  ): Promise<Page<EntityIntegrityReport>> {
    const entities = await this.listEntities({
      ...options,
      includeDeleted: true,
    });
    const reports: EntityIntegrityReport[] = [];
    for (const { entityId } of entities.items)
      reports.push(await this.inspectEntityIntegrity(entityId));
    return { items: reports, cursor: entities.cursor };
  }

  async verifyAuditChain(id: EntityId): Promise<EntityIntegrityReport> {
    const stored = await this.getEntity(id);
    const rows = await this.#db
      .prepare(
        `SELECT entity_id, revision, entity_json, actor, attribution_json, edit_summary,
        tags_json, event_id, content_hash, parent_hash, deleted_at, redirect_to, created_at
       FROM taproot_entity_revisions WHERE entity_id = ? ORDER BY revision`,
      )
      .bind(id)
      .all<RevisionRow>();
    const issues: EntityIntegrityReport['issues'] = [];
    let parentHash: string | null = null;
    let expectedRevision = rows.results[0]?.revision ?? 1;
    for (const row of rows.results) {
      if (row.revision !== expectedRevision)
        issues.push({
          code: 'current-revision-mismatch',
          message: `Revision sequence skips from ${expectedRevision - 1} to ${row.revision}`,
        });
      const actualHash = await revisionContentHash(row.entity_json, {
        deletedAt: row.deleted_at,
        redirectTo: row.redirect_to,
      });
      if (actualHash !== row.content_hash)
        issues.push({
          code: 'content-hash-mismatch',
          message: `Revision ${row.revision} content hash is invalid`,
        });
      if (row.parent_hash !== parentHash)
        issues.push({
          code: 'content-hash-mismatch',
          message: `Revision ${row.revision} does not link to its parent`,
        });
      const audit = await this.#db
        .prepare(
          `SELECT content_hash, parent_hash FROM taproot_audit_events WHERE event_id = ?`,
        )
        .bind(row.event_id)
        .all<{ content_hash: string; parent_hash: string | null }>();
      if (
        !audit.results[0] ||
        audit.results[0].content_hash !== row.content_hash ||
        audit.results[0].parent_hash !== row.parent_hash
      )
        issues.push({
          code: 'audit-event-missing',
          message: `Revision ${row.revision} has no matching audit event`,
        });
      parentHash = row.content_hash;
      expectedRevision = row.revision + 1;
    }
    if (rows.results.at(-1)?.revision !== stored.entity.lastrevid)
      issues.push({
        code: 'current-revision-mismatch',
        message: 'Current entity revision is not the chain head',
      });
    return {
      entityId: id,
      revision: stored.entity.lastrevid,
      valid: issues.length === 0,
      issues,
    };
  }

  async repairEntityProjection(
    id: EntityId,
    metadata: EditMetadata = {},
  ): Promise<EntityIntegrityReport> {
    const started = performance.now();
    const stored = await this.getEntity(id);
    const before = await this.inspectEntityIntegrity(id);
    const expected = this.#lifecycleQuads(stored.entity, {
      deletedAt: stored.deletedAt,
      redirectTo: stored.redirectTo,
    });
    const actual = await this.#ownedQuads(id);
    const patch = this.#preparePatch({ insert: expected });
    const json = exportEntityJson(stored.entity, this.#options.maxEntityBytes);
    const parentHash = await revisionContentHash(json, {
      deletedAt: stored.deletedAt,
      redirectTo: stored.redirectTo,
    });
    const context = await this.#writeContext(
      stored.entity,
      json,
      metadata,
      parentHash,
      'repair',
      {
        deletedAt: stored.deletedAt,
        redirectTo: stored.redirectTo,
      },
    );
    const statements: SqlitePreparedStatementLike[] = [
      this.#db
        .prepare(`DELETE FROM taproot_terms WHERE entity_id = ?`)
        .bind(id),
      this.#termsInsert(stored.entity),
      this.#auditInsert(stored.entity, metadata, context),
      ...patch.statements,
      ...this.#ownershipPatch(id, actual, expected).statements,
    ];
    try {
      await this.#db.batch(statements);
    } catch (error) {
      const cause = toError(error);
      this.#emitObservation(
        'repair',
        started,
        'error',
        id,
        stored.entity.lastrevid,
        cause,
      );
      if (isEventIdUniqueError(cause))
        throw new RevisionConflictError(
          'Generated audit event id already exists',
          { cause },
        );
      throw cause;
    }
    const after = await this.inspectEntityIntegrity(id);
    this.#emitObservation(
      'repair',
      started,
      'success',
      id,
      stored.entity.lastrevid,
    );
    if (
      !after.valid &&
      before.issues.some(
        (issue) =>
          issue.code !== 'term-projection-mismatch' &&
          issue.code !== 'rdf-projection-mismatch',
      )
    ) {
      return after;
    }
    return after;
  }

  async #create(
    entity: WikibaseEntity,
    metadata: EditMetadata,
    allocated: boolean,
    eventType: AuditEventType,
  ): Promise<WriteResult> {
    const started = performance.now();
    validateEntity(entity);
    if (await this.#loadRow(entity.id))
      throw new EntityAlreadyExistsError(`Entity ${entity.id} already exists`);
    await this.#validatePropertyDatatypes(entity);
    await this.#runValidators(entity, null, metadata);
    const json = exportEntityJson(entity, this.#options.maxEntityBytes);
    const lifecycle = { deletedAt: null, redirectTo: null };
    const context = await this.#writeContext(
      entity,
      json,
      metadata,
      null,
      eventType,
      lifecycle,
    );
    const newQuads = this.#lifecycleQuads(entity, lifecycle);
    const marker = revisionQuad(entity, this.#options);
    const patch = this.#preparePatch({ forbid: [marker], insert: newQuads });
    const statements: SqlitePreparedStatementLike[] =
      this.#namespaceStatements();
    if (allocated) {
      const type = entity.type;
      const numeric = entityNumericId(entity.id);
      statements.push(
        this.#db
          .prepare(
            `UPDATE taproot_id_counters SET next_numeric_id = ? WHERE entity_type = ? AND next_numeric_id = ?`,
          )
          .bind(numeric + 1, type, numeric),
        this.#assertion(
          `EXISTS (SELECT 1 FROM taproot_id_counters WHERE entity_type = ? AND next_numeric_id = ?)`,
          type,
          numeric + 1,
        ),
      );
    } else {
      statements.push(
        this.#db
          .prepare(
            `UPDATE taproot_id_counters SET next_numeric_id = MAX(next_numeric_id, ?) WHERE entity_type = ?`,
          )
          .bind(entityNumericId(entity.id) + 1, entity.type),
      );
    }
    statements.push(
      this.#db
        .prepare(
          `INSERT INTO taproot_entities(entity_id, entity_type, datatype, revision, entity_json, modified_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          entity.id,
          entity.type,
          entity.type === 'property' ? entity.datatype : null,
          entity.lastrevid,
          json,
          entity.modified,
        ),
      this.#revisionInsert(entity, json, metadata, context),
      this.#auditInsert(entity, metadata, context),
      this.#termsInsert(entity),
    );
    const patchOffset = statements.length;
    statements.push(...patch.statements);
    const ownership = this.#ownershipPatch(entity.id, [], newQuads);
    const ownershipOffset = statements.length;
    statements.push(...ownership.statements);
    try {
      const results = await this.#db.batch(statements);
      const result = {
        entityId: entity.id,
        previousRevision: null,
        newRevision: entity.lastrevid,
        entity,
        quadPatch: {
          ...patch.readResult(results, patchOffset),
          deleted: ownership.deleted(results, ownershipOffset),
        },
        eventId: context.eventId,
        contentHash: context.contentHash,
      };
      this.#emitObservation(
        eventType,
        started,
        'success',
        entity.id,
        entity.lastrevid,
      );
      return result;
    } catch (cause) {
      this.#emitObservation(
        eventType,
        started,
        'error',
        entity.id,
        entity.lastrevid,
        cause,
      );
      const mapped = patch.mapError(cause);
      if (isAssertionError(mapped) && (await this.#namespaceMismatch())) {
        throw new SchemaMismatchError(
          `This database is bound to a different Taproot base IRI`,
          { cause: mapped },
        );
      }
      if (
        mapped instanceof QuadPatchConflictError ||
        isUniqueEntityError(mapped)
      ) {
        throw new EntityAlreadyExistsError(
          `Entity ${entity.id} already exists`,
          { cause: mapped },
        );
      }
      if (isEventIdUniqueError(mapped))
        throw new RevisionConflictError(
          'Generated audit event id already exists',
          { cause: mapped },
        );
      if (allocated && isAssertionError(mapped))
        throw new RevisionConflictError(
          `ID allocation for ${entity.id} was stale`,
          { cause: mapped },
        );
      throw mapped;
    }
  }

  async #mutate(
    id: EntityId,
    edit: ExpectedRevision,
    transform: (entity: WikibaseEntity) => WikibaseEntity,
    lifecycleOverride?: Lifecycle,
    eventType: AuditEventType = 'update',
  ): Promise<WriteResult> {
    const started = performance.now();
    const row = await this.#loadRow(id);
    if (!row) throw new EntityNotFoundError(`Entity ${id} was not found`);
    const stored = storedFromRow(row);
    if (stored.entity.lastrevid !== edit.expectedRevision) {
      throw new RevisionConflictError(
        `Expected ${id}@${edit.expectedRevision}, found ${stored.entity.lastrevid}`,
      );
    }
    const previous = stored.entity.lastrevid;
    const next = transform(cloneEntity(stored.entity));
    next.lastrevid = previous + 1;
    next.modified = this.#options.clock().toISOString();
    if (next.id !== id || next.type !== stored.entity.type)
      throw new InvalidEntityError('Entity identity and type are immutable');
    if (
      stored.entity.type === 'property' &&
      next.type === 'property' &&
      stored.entity.datatype !== next.datatype &&
      (await this.#propertyInUse(stored.entity.id))
    ) {
      throw new InvalidEntityError('Property datatype is immutable after use');
    }
    validateEntity(next);
    await this.#validatePropertyDatatypes(next);
    await this.#runValidators(next, stored.entity, edit);
    const oldLifecycle = {
      deletedAt: stored.deletedAt,
      redirectTo: stored.redirectTo,
    };
    const json = exportEntityJson(next, this.#options.maxEntityBytes);
    const parentHash =
      row.content_hash ??
      (await revisionContentHash(row.entity_json, oldLifecycle));
    const newLifecycle = lifecycleOverride ?? oldLifecycle;
    const context = await this.#writeContext(
      next,
      json,
      edit,
      parentHash,
      eventType,
      newLifecycle,
    );
    const oldQuads = this.#lifecycleQuads(stored.entity, oldLifecycle);
    const newQuads = this.#lifecycleQuads(next, newLifecycle);
    const patch = this.#preparePatch({
      require: [revisionQuad(stored.entity, this.#options)],
      insert: newQuads,
    });
    const statements: SqlitePreparedStatementLike[] = [
      ...this.#namespaceStatements(),
      this.#db
        .prepare(
          `UPDATE taproot_entities SET datatype = ?, revision = ?, entity_json = ?, modified_at = ?, deleted_at = ?, redirect_to = ? WHERE entity_id = ? AND revision = ?`,
        )
        .bind(
          next.type === 'property' ? next.datatype : null,
          next.lastrevid,
          json,
          next.modified,
          newLifecycle.deletedAt,
          newLifecycle.redirectTo,
          id,
          previous,
        ),
      this.#assertion(
        `EXISTS (SELECT 1 FROM taproot_entities WHERE entity_id = ? AND revision = ?)`,
        id,
        next.lastrevid,
      ),
      this.#revisionInsert(next, json, edit, context),
      this.#auditInsert(next, edit, context),
      this.#db
        .prepare('DELETE FROM taproot_terms WHERE entity_id = ?')
        .bind(id),
      this.#termsInsert(next),
    ];
    const patchOffset = statements.length;
    statements.push(...patch.statements);
    const ownership = this.#ownershipPatch(id, oldQuads, newQuads);
    const ownershipOffset = statements.length;
    statements.push(...ownership.statements);
    try {
      const results = await this.#db.batch(statements);
      const result = {
        entityId: id,
        previousRevision: previous,
        newRevision: next.lastrevid,
        entity: next,
        quadPatch: {
          ...patch.readResult(results, patchOffset),
          deleted: ownership.deleted(results, ownershipOffset),
        },
        eventId: context.eventId,
        contentHash: context.contentHash,
      };
      this.#emitObservation(eventType, started, 'success', id, next.lastrevid);
      return result;
    } catch (cause) {
      this.#emitObservation(
        eventType,
        started,
        'error',
        id,
        next.lastrevid,
        cause,
      );
      const mapped = patch.mapError(cause);
      if (isAssertionError(mapped) && (await this.#namespaceMismatch())) {
        throw new SchemaMismatchError(
          `This database is bound to a different Taproot base IRI`,
          { cause: mapped },
        );
      }
      if (
        mapped instanceof QuadPatchConflictError ||
        isAssertionError(mapped) ||
        isRevisionUniqueError(mapped)
      ) {
        throw new RevisionConflictError(
          `Entity ${id} changed after revision ${previous}`,
          { cause: mapped },
        );
      }
      if (isEventIdUniqueError(mapped))
        throw new RevisionConflictError(
          'Generated audit event id already exists',
          { cause: mapped },
        );
      throw mapped;
    }
  }

  #preparePatch(patch: Parameters<typeof prepareQuadPatch>[1]) {
    try {
      return prepareQuadPatch(this.#db, patch);
    } catch (cause) {
      if (cause instanceof RangeError)
        throw new QuadPatchTooLargeError(cause.message, { cause });
      throw cause;
    }
  }

  #ownershipPatch(
    entityId: EntityId,
    oldQuads: RDF.Quad[],
    newQuads: RDF.Quad[],
  ) {
    const oldRows = oldQuads.map(ownershipRow);
    const newRows = newQuads.map(ownershipRow);
    const statements: SqlitePreparedStatementLike[] = [
      this.#db
        .prepare(`DELETE FROM taproot_rdf_ownership WHERE entity_id = ?`)
        .bind(entityId),
    ];
    if (newRows.length) {
      statements.push(
        this.#db
          .prepare(
            `INSERT INTO taproot_rdf_ownership(entity_id, subject_key, predicate_key, object_key, graph_key)
         SELECT ?, json_extract(value, '$.subjectKey'), json_extract(value, '$.predicateKey'),
           json_extract(value, '$.objectKey'), json_extract(value, '$.graphKey') FROM json_each(?)`,
          )
          .bind(entityId, JSON.stringify(newRows)),
      );
    }
    let deleteIndex = -1;
    if (oldRows.length) {
      deleteIndex = statements.length;
      statements.push(
        this.#db
          .prepare(
            `DELETE FROM rdf_quads AS q WHERE EXISTS (
          SELECT 1 FROM json_each(?) old
          WHERE q.subject_key = json_extract(old.value, '$.subjectKey')
            AND q.predicate_key = json_extract(old.value, '$.predicateKey')
            AND q.object_key = json_extract(old.value, '$.objectKey')
            AND q.graph_key = json_extract(old.value, '$.graphKey')
        ) AND NOT EXISTS (
          SELECT 1 FROM taproot_rdf_ownership own
          WHERE own.subject_key = q.subject_key AND own.predicate_key = q.predicate_key
            AND own.object_key = q.object_key AND own.graph_key = q.graph_key
        )`,
          )
          .bind(JSON.stringify(oldRows)),
      );
    }
    return {
      statements,
      deleted: (
        results: Awaited<ReturnType<SqliteDatabaseLike['batch']>>,
        offset: number,
      ) =>
        deleteIndex < 0
          ? 0
          : Number(results[offset + deleteIndex]?.meta?.changes ?? 0),
    };
  }

  async #ownedQuads(entityId: EntityId): Promise<RDF.Quad[]> {
    const result = await this.#db
      .prepare(
        `SELECT q.subject_key, q.subject_json, q.predicate_key, q.predicate_json,
        q.object_key, q.object_json, q.graph_key, q.graph_json
       FROM taproot_rdf_ownership own JOIN rdf_quads q
        ON q.subject_key = own.subject_key AND q.predicate_key = own.predicate_key
        AND q.object_key = own.object_key AND q.graph_key = own.graph_key
       WHERE own.entity_id = ?`,
      )
      .bind(entityId)
      .all<{
        subject_key: string;
        subject_json: string;
        predicate_key: string;
        predicate_json: string;
        object_key: string;
        object_json: string;
        graph_key: string;
        graph_json: string;
      }>();
    const factory = this.#options.factory ?? new DataFactory();
    return result.results.map((row) =>
      factory.quad(
        decodeTerm(row.subject_json) as RDF.Quad_Subject,
        decodeTerm(row.predicate_json) as RDF.Quad_Predicate,
        decodeTerm(row.object_json) as RDF.Quad_Object,
        decodeTerm(row.graph_json) as RDF.Quad_Graph,
      ),
    );
  }

  async #validatePropertyDatatypes(entity: WikibaseEntity): Promise<void> {
    const used = new Map<PropertyId, EntityDatatype>();
    for (const statements of Object.values(entity.claims)) {
      for (const statement of statements) {
        collectSnak(statement.mainsnak, used);
        for (const snaks of Object.values(statement.qualifiers))
          for (const snak of snaks) collectSnak(snak, used);
        for (const reference of statement.references)
          for (const snaks of Object.values(reference.snaks))
            for (const snak of snaks) collectSnak(snak, used);
      }
    }
    if (!used.size) return;
    const ids = JSON.stringify([...used.keys()]);
    const properties = await this.#db
      .prepare(
        `SELECT entity_id, datatype FROM taproot_entities WHERE entity_id IN (SELECT value FROM json_each(?)) AND entity_type = 'property' AND deleted_at IS NULL`,
      )
      .bind(ids)
      .all<{ entity_id: PropertyId; datatype: EntityDatatype }>();
    const actual = new Map(
      properties.results.map((row) => [row.entity_id, row.datatype]),
    );
    if (entity.type === 'property') actual.set(entity.id, entity.datatype);
    for (const [property, datatype] of used) {
      const expected = actual.get(property);
      if (!expected)
        throw new PropertyNotFoundError(`Property ${property} was not found`);
      if (expected !== datatype)
        throw new PropertyDatatypeMismatchError(
          `Property ${property} requires ${expected}, received ${datatype}`,
        );
    }
  }

  async #nextId(type: 'item' | 'property'): Promise<EntityId> {
    const result = await this.#db
      .prepare(
        'SELECT next_numeric_id FROM taproot_id_counters WHERE entity_type = ?',
      )
      .bind(type)
      .all<{ next_numeric_id: number }>();
    const numeric = result.results[0]?.next_numeric_id;
    if (!numeric) throw new InvalidEntityError(`Missing ${type} ID counter`);
    return `${type === 'item' ? 'Q' : 'P'}${numeric}` as EntityId;
  }

  async #propertyInUse(id: PropertyId): Promise<boolean> {
    const result = await this.#db
      .prepare(
        `SELECT 1 AS used FROM taproot_entities
         WHERE entity_json LIKE ? ESCAPE '\\' LIMIT 1`,
      )
      .bind(`%"property":"${id}"%`)
      .all<{ used: number }>();
    return result.results.length > 0;
  }

  async #loadRow(id: EntityId): Promise<EntityRow | undefined> {
    const result = await this.#db
      .prepare(
        `SELECT e.entity_json, e.deleted_at, e.redirect_to, r.content_hash
         FROM taproot_entities e LEFT JOIN taproot_entity_revisions r
           ON r.entity_id = e.entity_id AND r.revision = e.revision
         WHERE e.entity_id = ?`,
      )
      .bind(id)
      .all<EntityRow>();
    return result.results[0];
  }

  #revisionInsert(
    entity: WikibaseEntity,
    json: string,
    metadata: EditMetadata,
    context: WriteContext,
  ): SqlitePreparedStatementLike {
    return this.#db
      .prepare(
        `INSERT INTO taproot_entity_revisions(
          entity_id, revision, entity_json, actor, attribution_json, edit_summary,
          tags_json, event_id, content_hash, parent_hash, deleted_at, redirect_to, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        entity.id,
        entity.lastrevid,
        json,
        metadata.actor ?? context.attribution?.id ?? null,
        context.attribution ? JSON.stringify(context.attribution) : null,
        metadata.editSummary ?? null,
        JSON.stringify(context.tags),
        context.eventId,
        context.contentHash,
        context.parentHash,
        context.lifecycle.deletedAt,
        context.lifecycle.redirectTo,
        context.createdAt,
      );
  }

  #auditInsert(
    entity: WikibaseEntity,
    metadata: EditMetadata,
    context: WriteContext,
  ): SqlitePreparedStatementLike {
    return this.#db
      .prepare(
        `INSERT INTO taproot_audit_events(
          event_id, entity_id, revision, event_type, attribution_json, edit_summary,
          tags_json, request_id, content_hash, parent_hash, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        context.eventId,
        entity.id,
        entity.lastrevid,
        context.eventType,
        context.attribution ? JSON.stringify(context.attribution) : null,
        metadata.editSummary ?? null,
        JSON.stringify(context.tags),
        metadata.requestId ?? null,
        context.contentHash,
        context.parentHash,
        JSON.stringify(context.lifecycle),
        context.createdAt,
      );
  }

  async #writeContext(
    entity: WikibaseEntity,
    json: string,
    metadata: EditMetadata,
    parentHash: string | null,
    eventType: AuditEventType,
    lifecycle: Lifecycle,
  ): Promise<WriteContext> {
    const attribution = normalizeAttribution(metadata);
    if (this.#options.requireAttribution && !attribution)
      throw new InvalidEntityError(
        'Attribution is required for knowledge writes',
      );
    const tags = normalizeTags(metadata.tags);
    if (
      metadata.editSummary !== undefined &&
      (typeof metadata.editSummary !== 'string' ||
        metadata.editSummary.length > 1_000)
    )
      throw new InvalidEntityError(
        'Edit summary must be a string of at most 1,000 characters',
      );
    if (
      metadata.requestId !== undefined &&
      (typeof metadata.requestId !== 'string' ||
        !metadata.requestId.trim() ||
        metadata.requestId.length > 256)
    )
      throw new InvalidEntityError(
        'Request id must contain 1 through 256 characters',
      );
    const eventId = this.#options.createId();
    if (typeof eventId !== 'string' || !eventId.trim() || eventId.length > 128)
      throw new InvalidEntityError(
        'Generated event id must contain 1 through 128 characters',
      );
    return {
      eventId,
      contentHash: await revisionContentHash(json, lifecycle),
      parentHash,
      eventType,
      attribution,
      tags,
      createdAt: this.#options.clock().toISOString(),
      lifecycle,
    };
  }

  async #runValidators(
    entity: WikibaseEntity,
    previous: WikibaseEntity | null,
    metadata: EditMetadata,
  ): Promise<void> {
    for (const validator of this.#options.validators) {
      await validator(entity, { previous, metadata });
    }
  }

  #emitObservation(
    operation: string,
    started: number,
    outcome: 'success' | 'error',
    entityId?: EntityId,
    revision?: number,
    error?: unknown,
  ): void {
    if (!this.#options.observe) return;
    try {
      const result = this.#options.observe({
        operation,
        outcome,
        durationMs: performance.now() - started,
        ...(entityId ? { entityId } : {}),
        ...(revision === undefined ? {} : { revision }),
        ...(error === undefined ? {} : { error }),
      });
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch {
      // Observers are deliberately isolated from committed knowledge writes.
    }
  }

  #termsInsert(entity: WikibaseEntity): SqlitePreparedStatementLike {
    const rows = terms(entity);
    return this.#db
      .prepare(
        `INSERT INTO taproot_terms(entity_id, language, term_type, value, ordinal)
      SELECT json_extract(value, '$.entityId'), json_extract(value, '$.language'), json_extract(value, '$.termType'), json_extract(value, '$.value'), json_extract(value, '$.ordinal')
      FROM json_each(?)`,
      )
      .bind(JSON.stringify(rows));
  }

  #assertion(
    condition: string,
    ...values: unknown[]
  ): SqlitePreparedStatementLike {
    return this.#db
      .prepare(
        `INSERT INTO taproot_assertions(assertion_key) SELECT NULL WHERE NOT (${condition})`,
      )
      .bind(...values);
  }

  #namespaceStatements(): SqlitePreparedStatementLike[] {
    return [
      this.#assertion(
        `EXISTS (SELECT 1 FROM taproot_metadata
          WHERE metadata_key = 'base_iri' AND metadata_value = ?)`,
        withoutTrailingSlashes(this.#options.baseIri),
      ),
    ];
  }

  async #namespaceMismatch(): Promise<boolean> {
    const result = await this.#db
      .prepare(
        `SELECT metadata_value FROM taproot_metadata
         WHERE metadata_key = 'base_iri'`,
      )
      .all<{ metadata_value: string }>();
    const actual = result.results[0]?.metadata_value;
    return (
      actual !== undefined &&
      actual !== withoutTrailingSlashes(this.#options.baseIri)
    );
  }

  #lifecycleQuads(entity: WikibaseEntity, lifecycle: Lifecycle): RDF.Quad[] {
    if (!lifecycle.deletedAt && !lifecycle.redirectTo)
      return buildEntityQuads(entity, this.#options);
    const factory = this.#options.factory ?? new DataFactory();
    const base = withoutTrailingSlashes(this.#options.baseIri);
    const subject = factory.namedNode(`${base}/entity/${entity.id}`);
    const quads = [revisionQuad(entity, { ...this.#options, factory })];
    if (lifecycle.deletedAt) {
      quads.push(
        factory.quad(
          subject,
          factory.namedNode(`${base}/vocab/deletedAt`),
          factory.literal(
            lifecycle.deletedAt,
            factory.namedNode('http://www.w3.org/2001/XMLSchema#dateTime'),
          ),
        ),
      );
    }
    if (lifecycle.redirectTo) {
      quads.push(
        factory.quad(
          subject,
          factory.namedNode('http://www.w3.org/2002/07/owl#sameAs'),
          factory.namedNode(`${base}/entity/${lifecycle.redirectTo}`),
        ),
      );
    }
    return quads;
  }
}

function storedFromRow(row: EntityRow): StoredEntity {
  return {
    entity: parseEntityJson(row.entity_json),
    deletedAt: row.deleted_at,
    redirectTo: row.redirect_to as EntityId | null,
  };
}

function revisionFromRow(row: RevisionRow): RevisionEntry {
  return {
    entityId: row.entity_id,
    revision: row.revision,
    entity: parseEntityJson(row.entity_json),
    actor: row.actor,
    attribution: row.attribution_json
      ? (JSON.parse(row.attribution_json) as Attribution)
      : null,
    editSummary: row.edit_summary,
    tags: JSON.parse(row.tags_json) as string[],
    eventId: row.event_id,
    contentHash: row.content_hash,
    parentHash: row.parent_hash,
    deletedAt: row.deleted_at,
    redirectTo: row.redirect_to,
    createdAt: row.created_at,
  };
}

function auditFromRow(row: AuditRow): AuditEvent {
  return {
    sequence: row.event_sequence,
    eventId: row.event_id,
    entityId: row.entity_id,
    revision: row.revision,
    type: row.event_type,
    attribution: row.attribution_json
      ? (JSON.parse(row.attribution_json) as Attribution)
      : null,
    editSummary: row.edit_summary,
    tags: JSON.parse(row.tags_json) as string[],
    requestId: row.request_id,
    contentHash: row.content_hash,
    parentHash: row.parent_hash,
    lifecycle: JSON.parse(row.details_json) as AuditEvent['lifecycle'],
    createdAt: row.created_at,
  };
}

function terms(entity: WikibaseEntity) {
  const rows: Array<{
    entityId: EntityId;
    language: string;
    termType: SearchResult['termType'];
    value: string;
    ordinal: number;
  }> = [];
  for (const [language, term] of Object.entries(entity.labels))
    rows.push({
      entityId: entity.id,
      language,
      termType: 'label',
      value: term.value,
      ordinal: 0,
    });
  for (const [language, term] of Object.entries(entity.descriptions))
    rows.push({
      entityId: entity.id,
      language,
      termType: 'description',
      value: term.value,
      ordinal: 0,
    });
  for (const [language, aliases] of Object.entries(entity.aliases))
    aliases.forEach((term, ordinal) =>
      rows.push({
        entityId: entity.id,
        language,
        termType: 'alias',
        value: term.value,
        ordinal,
      }),
    );
  return rows;
}

function locateStatement(
  entity: WikibaseEntity,
  id: string,
): {
  property: PropertyId;
  statements: Statement[];
  statement: Statement;
  index: number;
} {
  for (const [property, statements] of Object.entries(entity.claims) as Array<
    [PropertyId, Statement[]]
  >) {
    const index = statements.findIndex((statement) => statement.id === id);
    if (index >= 0)
      return {
        property,
        statements,
        statement: statements[index] as Statement,
        index,
      };
  }
  throw new InvalidStatementError(`Statement ${id} does not exist`);
}

function resupplyStatementTexts(
  entity: WikibaseEntity,
  supplied: Readonly<Record<string, string>>,
): WikibaseEntity {
  const expected = new Set<string>();
  for (const statements of Object.values(entity.claims)) {
    for (const statement of statements) {
      expected.add(statement.id);
      if (!Object.hasOwn(supplied, statement.id))
        throw new InvalidStatementError(
          `Statement ${statement.id} text must be explicitly resupplied for this revision`,
        );
      const text = supplied[statement.id];
      assertAuthoredStatementText(text, statement.id);
      statement.text = text;
    }
  }
  const unexpected = Object.keys(supplied).filter((id) => !expected.has(id));
  if (unexpected.length)
    throw new InvalidStatementError(
      `Statement text was supplied for unknown statement ${unexpected[0]}`,
    );
  return entity;
}

function authoredStatementTexts(
  entity: WikibaseEntity,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.values(entity.claims).flatMap((statements) =>
      statements.map((statement) => [statement.id, statement.text]),
    ),
  );
}

function collectSnak(snak: Snak, used: Map<PropertyId, EntityDatatype>): void {
  const current = used.get(snak.property);
  if (current && current !== snak.datatype)
    throw new PropertyDatatypeMismatchError(
      `Property ${snak.property} is used with multiple datatypes`,
    );
  used.set(snak.property, snak.datatype);
}

function applyEntityCommand(
  entity: WikibaseEntity,
  command: EntityCommand,
): void {
  if (command.type === 'add-statement' || command.type === 'replace-statement')
    assertAuthoredStatementText(command.statement.text, command.statement.id);
  else if (
    command.type === 'set-statement-rank' ||
    command.type === 'add-qualifier' ||
    command.type === 'remove-qualifier' ||
    command.type === 'add-reference' ||
    command.type === 'replace-reference' ||
    command.type === 'remove-reference'
  )
    assertAuthoredStatementText(command.text, command.statementId);
  switch (command.type) {
    case 'set-label':
      entity.labels[command.language] = {
        language: command.language,
        value: command.value,
      };
      break;
    case 'remove-label':
      delete entity.labels[command.language];
      break;
    case 'set-description':
      entity.descriptions[command.language] = {
        language: command.language,
        value: command.value,
      };
      break;
    case 'remove-description':
      delete entity.descriptions[command.language];
      break;
    case 'add-alias':
      (entity.aliases[command.language] ??= []).push({
        language: command.language,
        value: command.value,
      });
      break;
    case 'remove-alias': {
      const aliases = entity.aliases[command.language];
      if (!aliases?.[command.ordinal])
        throw new InvalidEntityError('Alias does not exist');
      aliases.splice(command.ordinal, 1);
      if (!aliases.length) delete entity.aliases[command.language];
      break;
    }
    case 'set-sitelink':
      if (entity.type !== 'item')
        throw new InvalidEntityError('Properties cannot have sitelinks');
      entity.sitelinks[command.site] = structuredClone(command.value);
      break;
    case 'remove-sitelink':
      if (entity.type !== 'item')
        throw new InvalidEntityError('Properties cannot have sitelinks');
      delete entity.sitelinks[command.site];
      break;
    case 'add-statement': {
      const property = command.statement.mainsnak.property;
      (entity.claims[property] ??= []).push(structuredClone(command.statement));
      break;
    }
    case 'replace-statement': {
      const located = locateStatement(entity, command.statementId);
      located.statements.splice(located.index, 1);
      const property = command.statement.mainsnak.property;
      (entity.claims[property] ??= []).push(structuredClone(command.statement));
      if (!located.statements.length) delete entity.claims[located.property];
      break;
    }
    case 'remove-statement': {
      const located = locateStatement(entity, command.statementId);
      located.statements.splice(located.index, 1);
      if (!located.statements.length) delete entity.claims[located.property];
      break;
    }
    case 'set-statement-rank':
      locateStatement(entity, command.statementId).statement.rank =
        command.rank;
      locateStatement(entity, command.statementId).statement.text =
        command.text;
      break;
    case 'add-qualifier': {
      validateSnak(command.snak);
      const statement = locateStatement(entity, command.statementId).statement;
      statement.text = command.text;
      const property = command.snak.property;
      if (!statement.qualifiers[property]) {
        statement.qualifiers[property] = [];
        statement['qualifiers-order'].push(property);
      }
      statement.qualifiers[property].push(structuredClone(command.snak));
      break;
    }
    case 'remove-qualifier': {
      const statement = locateStatement(entity, command.statementId).statement;
      statement.text = command.text;
      const snaks = statement.qualifiers[command.property];
      if (!snaks?.[command.ordinal])
        throw new InvalidStatementError('Qualifier does not exist');
      snaks.splice(command.ordinal, 1);
      if (!snaks.length) {
        delete statement.qualifiers[command.property];
        statement['qualifiers-order'] = statement['qualifiers-order'].filter(
          (id) => id !== command.property,
        );
      }
      break;
    }
    case 'add-reference': {
      const statement = locateStatement(entity, command.statementId).statement;
      statement.text = command.text;
      statement.references.push(structuredClone(command.reference));
      break;
    }
    case 'replace-reference': {
      const statement = locateStatement(entity, command.statementId).statement;
      statement.text = command.text;
      const references = statement.references;
      const index = references.findIndex(({ hash }) => hash === command.hash);
      if (index < 0)
        throw new InvalidStatementError(
          `Reference ${command.hash} does not exist`,
        );
      references[index] = structuredClone(command.reference);
      break;
    }
    case 'remove-reference': {
      const statement = locateStatement(entity, command.statementId).statement;
      statement.text = command.text;
      const references = statement.references;
      const index = references.findIndex(({ hash }) => hash === command.hash);
      if (index < 0)
        throw new InvalidStatementError(
          `Reference ${command.hash} does not exist`,
        );
      references.splice(index, 1);
      break;
    }
  }
}

function revisionQuad(
  entity: WikibaseEntity,
  options: TaprootOptions,
): RDF.Quad {
  const factory = options.factory ?? new DataFactory();
  const base = withoutTrailingSlashes(options.baseIri);
  return factory.quad(
    factory.namedNode(`${base}/entity/${entity.id}`),
    factory.namedNode(`${base}/vocab/revision`),
    factory.literal(
      String(entity.lastrevid),
      factory.namedNode('http://www.w3.org/2001/XMLSchema#integer'),
    ),
  );
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500)
    throw new RangeError('limit must be an integer from 1 through 500');
}

function isAssertionError(cause: Error): boolean {
  return /NOT NULL constraint failed: taproot_assertions\.assertion_key/iu.test(
    cause.message,
  );
}

function isUniqueEntityError(cause: Error): boolean {
  return /UNIQUE constraint failed: taproot_entities\.entity_id/iu.test(
    cause.message,
  );
}

function isRevisionUniqueError(cause: Error): boolean {
  return /UNIQUE constraint failed: taproot_entity_revisions\.entity_id, taproot_entity_revisions\.revision/iu.test(
    cause.message,
  );
}

function isEventIdUniqueError(cause: Error): boolean {
  return /UNIQUE constraint failed: taproot_audit_events\.event_id/iu.test(
    cause.message,
  );
}

function normalizeAttribution(metadata: EditMetadata): Attribution | null {
  if (metadata.actor !== undefined && typeof metadata.actor !== 'string')
    throw new InvalidEntityError('Legacy actor must be a string');
  const attribution =
    metadata.attribution ??
    (metadata.actor ? { id: metadata.actor, kind: 'human' as const } : null);
  if (!attribution) return null;
  if (typeof attribution.id !== 'string' || !attribution.id.trim())
    throw new InvalidEntityError('Attribution id cannot be empty');
  if (!['human', 'agent', 'import', 'system'].includes(attribution.kind))
    throw new InvalidEntityError('Attribution kind is invalid');
  for (const field of ['name', 'organization', 'tool'] as const) {
    const value = attribution[field];
    if (value !== undefined && (typeof value !== 'string' || !value.trim()))
      throw new InvalidEntityError(
        `Attribution ${field} must be a non-empty string`,
      );
  }
  if (new TextEncoder().encode(JSON.stringify(attribution)).byteLength > 16_384)
    throw new InvalidEntityError('Attribution cannot exceed 16 KiB');
  for (const field of ['url'] as const) {
    const value = attribution[field];
    if (value !== undefined) {
      if (typeof value !== 'string')
        throw new InvalidEntityError(`Attribution ${field} must be a string`);
      try {
        new URL(value);
      } catch (cause) {
        throw new InvalidEntityError(
          `Attribution ${field} must be an absolute URL`,
          { cause },
        );
      }
    }
  }
  return structuredClone(attribution);
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string'))
    throw new InvalidEntityError('Tags must be an array of strings');
  if (tags.length > 50)
    throw new InvalidEntityError('An edit may have at most 50 tags');
  const normalized = [...new Set(tags.map((tag) => tag.trim()))].sort();
  if (normalized.some((tag) => !tag || tag.length > 64))
    throw new InvalidEntityError('Tags must contain 1 through 64 characters');
  return normalized;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function revisionContentHash(
  json: string,
  lifecycle: Lifecycle,
): Promise<string> {
  return sha256(`${json}\n${JSON.stringify(lifecycle)}`);
}

function encodeCursor(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '');
}

function decodeCursor<T>(cursor: string): T {
  try {
    const padded =
      cursor.replace(/-/gu, '+').replace(/_/gu, '/') +
      '='.repeat((4 - (cursor.length % 4)) % 4);
    const binary = atob(padded);
    return JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(binary, (character) => character.charCodeAt(0)),
      ),
    ) as T;
  } catch (cause) {
    throw new InvalidCursorError('Cursor is invalid', { cause });
  }
}

function page<T>(
  items: T[],
  limit: number,
  cursorValue: (item: T) => unknown,
): Page<T> {
  const hasMore = items.length > limit;
  const visible = items.slice(0, limit);
  return {
    items: visible,
    cursor:
      hasMore && visible.length
        ? encodeCursor(cursorValue(visible[visible.length - 1] as T))
        : null,
  };
}

function termKey(term: RDF.Term): string {
  return JSON.stringify({
    type: term.termType,
    value: term.value,
    language: term.termType === 'Literal' ? term.language : undefined,
    datatype: term.termType === 'Literal' ? term.datatype.value : undefined,
  });
}

function quadKeyValue(quad: RDF.Quad): string {
  return [quad.subject, quad.predicate, quad.object, quad.graph]
    .map(termKey)
    .join('|');
}

function ownershipRow(quad: RDF.Quad) {
  return {
    subjectKey: encodeTerm(quad.subject).key,
    predicateKey: encodeTerm(quad.predicate).key,
    objectKey: encodeTerm(quad.object).key,
    graphKey: encodeTerm(quad.graph).key,
  };
}

function sameQuads(left: RDF.Quad[], right: RDF.Quad[]): boolean {
  const a = [...new Set(left.map(quadKeyValue))].sort();
  const b = [...new Set(right.map(quadKeyValue))].sort();
  return JSON.stringify(a) === JSON.stringify(b);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
