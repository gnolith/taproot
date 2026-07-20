import {
  QuadPatchConflictError,
  prepareQuadPatch,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from '@gnolith/diamond';
import type * as RDF from '@rdfjs/types';
import { DataFactory } from 'rdf-data-factory';
import {
  cloneEntity,
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
  PropertyDatatypeMismatchError,
  PropertyNotFoundError,
  QuadPatchTooLargeError,
  RevisionConflictError,
  SchemaMismatchError,
} from './errors.js';
import { buildEntityQuads } from './rdf.js';
import { TAPROOT_RDF_VERSION } from './schema.js';
import type {
  AliasMap,
  EditMetadata,
  EntityDatatype,
  EntityId,
  ExpectedRevision,
  Item,
  LanguageMap,
  Property,
  PropertyId,
  Reference,
  RevisionEntry,
  SearchResult,
  Sitelink,
  Snak,
  Statement,
  StoredEntity,
  TaprootOptions,
  WikibaseEntity,
  WriteResult,
} from './types.js';

interface EntityRow {
  entity_json: string;
  deleted_at: string | null;
  redirect_to: string | null;
}

interface RevisionRow {
  entity_id: EntityId;
  revision: number;
  entity_json: string;
  actor: string | null;
  edit_summary: string | null;
  created_at: string;
}

interface Lifecycle {
  deletedAt: string | null;
  redirectTo: EntityId | null;
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
}

export class TaprootRepository {
  readonly #db: D1DatabaseLike;
  readonly #options: Required<
    Pick<TaprootOptions, 'baseIri' | 'mappingVersion' | 'maxEntityBytes'>
  > &
    Pick<TaprootOptions, 'factory'>;

  constructor(db: D1DatabaseLike, options: TaprootOptions) {
    if (
      options.mappingVersion !== undefined &&
      options.mappingVersion !== TAPROOT_RDF_VERSION
    ) {
      throw new SchemaMismatchError(
        `RDF mapping version ${options.mappingVersion} is not supported`,
      );
    }
    try {
      new URL(options.baseIri);
    } catch (cause) {
      throw new InvalidEntityError('baseIri must be an absolute IRI', {
        cause,
      });
    }
    this.#db = db;
    this.#options = {
      baseIri: options.baseIri,
      mappingVersion: options.mappingVersion ?? '1',
      maxEntityBytes: options.maxEntityBytes ?? MAX_ENTITY_BYTES,
      ...(options.factory ? { factory: options.factory } : {}),
    };
  }

  async getEntity(id: EntityId): Promise<StoredEntity> {
    const row = await this.#loadRow(id);
    if (!row) throw new EntityNotFoundError(`Entity ${id} was not found`);
    return storedFromRow(row);
  }

  async getEntityRevision(
    id: EntityId,
    revision: number,
  ): Promise<RevisionEntry> {
    const result = await this.#db
      .prepare(
        `SELECT entity_id, revision, entity_json, actor, edit_summary, created_at
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
        `SELECT entity_id, revision, entity_json, actor, edit_summary, created_at
         FROM taproot_entity_revisions WHERE entity_id = ?
         ORDER BY revision DESC LIMIT ?`,
      )
      .bind(id, limit)
      .all<RevisionRow>();
    return result.results.map(revisionFromRow);
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
        modified: new Date().toISOString(),
      };
      try {
        return await this.#create(entity, input, input.id === undefined);
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
        modified: new Date().toISOString(),
      };
      try {
        return await this.#create(entity, input, input.id === undefined);
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
    return this.#create(imported, metadata, false);
  }

  async replaceEntity(
    id: EntityId,
    replacement: WikibaseEntity,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    if (replacement.id !== id)
      throw new InvalidEntityError('Replacement entity id cannot change');
    return this.#mutate(id, edit, () => cloneEntity(replacement));
  }

  async softDeleteEntity(
    id: EntityId,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    return this.#mutate(id, edit, (entity) => entity, {
      deletedAt: new Date().toISOString(),
      redirectTo: null,
    });
  }

  async restoreEntity(
    id: EntityId,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    return this.#mutate(id, edit, (entity) => entity, {
      deletedAt: null,
      redirectTo: null,
    });
  }

  async redirectEntity(
    id: EntityId,
    target: EntityId,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    if (id === target)
      throw new InvalidEntityError('An entity cannot redirect to itself');
    await this.getEntity(target);
    return this.#mutate(id, edit, (entity) => entity, {
      deletedAt: null,
      redirectTo: target,
    });
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
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    return this.#mutate(id, edit, (entity) => {
      locateStatement(entity, statementId).statement.rank = rank;
      return entity;
    });
  }

  async addQualifier(
    id: EntityId,
    statementId: string,
    snak: Snak,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    validateSnak(snak);
    return this.#mutate(id, edit, (entity) => {
      const statement = locateStatement(entity, statementId).statement;
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
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    return this.#mutate(id, edit, (entity) => {
      const statement = locateStatement(entity, statementId).statement;
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
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    return this.#mutate(id, edit, (entity) => {
      locateStatement(entity, statementId).statement.references.push(
        structuredClone(reference),
      );
      return entity;
    });
  }

  async removeReference(
    id: EntityId,
    statementId: string,
    hash: string,
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    return this.#mutate(id, edit, (entity) => {
      const references = locateStatement(entity, statementId).statement
        .references;
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
    edit: ExpectedRevision,
  ): Promise<WriteResult> {
    return this.#mutate(id, edit, (entity) => {
      const references = locateStatement(entity, statementId).statement
        .references;
      const index = references.findIndex((item) => item.hash === hash);
      if (index < 0)
        throw new InvalidStatementError(`Reference ${hash} does not exist`);
      references[index] = structuredClone(reference);
      return entity;
    });
  }

  async #create(
    entity: WikibaseEntity,
    metadata: EditMetadata,
    allocated: boolean,
  ): Promise<WriteResult> {
    validateEntity(entity);
    if (await this.#loadRow(entity.id))
      throw new EntityAlreadyExistsError(`Entity ${entity.id} already exists`);
    await this.#validatePropertyDatatypes(entity);
    const json = exportEntityJson(entity, this.#options.maxEntityBytes);
    const lifecycle = { deletedAt: null, redirectTo: null };
    const newQuads = this.#lifecycleQuads(entity, lifecycle);
    const marker = revisionQuad(entity, this.#options);
    const patch = this.#preparePatch({ forbid: [marker], insert: newQuads });
    const statements: D1PreparedStatementLike[] = this.#namespaceStatements();
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
      this.#revisionInsert(entity, json, metadata),
      this.#termsInsert(entity),
    );
    const patchOffset = statements.length;
    statements.push(...patch.statements);
    try {
      const results = await this.#db.batch(statements);
      return {
        entityId: entity.id,
        previousRevision: null,
        newRevision: entity.lastrevid,
        entity,
        quadPatch: patch.readResult(results, patchOffset),
      };
    } catch (cause) {
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
  ): Promise<WriteResult> {
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
    next.modified = new Date().toISOString();
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
    const json = exportEntityJson(next, this.#options.maxEntityBytes);
    const oldLifecycle = {
      deletedAt: stored.deletedAt,
      redirectTo: stored.redirectTo,
    };
    const newLifecycle = lifecycleOverride ?? oldLifecycle;
    const oldQuads = this.#lifecycleQuads(stored.entity, oldLifecycle);
    const newQuads = this.#lifecycleQuads(next, newLifecycle);
    const patch = this.#preparePatch({
      require: [revisionQuad(stored.entity, this.#options)],
      delete: oldQuads,
      insert: newQuads,
    });
    const statements: D1PreparedStatementLike[] = [
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
      this.#revisionInsert(next, json, edit),
      this.#db
        .prepare('DELETE FROM taproot_terms WHERE entity_id = ?')
        .bind(id),
      this.#termsInsert(next),
    ];
    const patchOffset = statements.length;
    statements.push(...patch.statements);
    try {
      const results = await this.#db.batch(statements);
      return {
        entityId: id,
        previousRevision: previous,
        newRevision: next.lastrevid,
        entity: next,
        quadPatch: patch.readResult(results, patchOffset),
      };
    } catch (cause) {
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
        'SELECT entity_json, deleted_at, redirect_to FROM taproot_entities WHERE entity_id = ?',
      )
      .bind(id)
      .all<EntityRow>();
    return result.results[0];
  }

  #revisionInsert(
    entity: WikibaseEntity,
    json: string,
    metadata: EditMetadata,
  ): D1PreparedStatementLike {
    return this.#db
      .prepare(
        `INSERT INTO taproot_entity_revisions(entity_id, revision, entity_json, actor, edit_summary) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        entity.id,
        entity.lastrevid,
        json,
        metadata.actor ?? null,
        metadata.editSummary ?? null,
      );
  }

  #termsInsert(entity: WikibaseEntity): D1PreparedStatementLike {
    const rows = terms(entity);
    return this.#db
      .prepare(
        `INSERT INTO taproot_terms(entity_id, language, term_type, value, ordinal)
      SELECT json_extract(value, '$.entityId'), json_extract(value, '$.language'), json_extract(value, '$.termType'), json_extract(value, '$.value'), json_extract(value, '$.ordinal')
      FROM json_each(?)`,
      )
      .bind(JSON.stringify(rows));
  }

  #assertion(condition: string, ...values: unknown[]): D1PreparedStatementLike {
    return this.#db
      .prepare(
        `INSERT INTO taproot_assertions(assertion_key) SELECT NULL WHERE NOT (${condition})`,
      )
      .bind(...values);
  }

  #namespaceStatements(): D1PreparedStatementLike[] {
    return [
      this.#db
        .prepare(
          `INSERT INTO taproot_metadata(metadata_key, metadata_value)
           VALUES ('base_iri', ?) ON CONFLICT(metadata_key) DO NOTHING`,
        )
        .bind(this.#options.baseIri.replace(/\/+$/u, '')),
      this.#assertion(
        `EXISTS (SELECT 1 FROM taproot_metadata
          WHERE metadata_key = 'base_iri' AND metadata_value = ?)`,
        this.#options.baseIri.replace(/\/+$/u, ''),
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
      actual !== this.#options.baseIri.replace(/\/+$/u, '')
    );
  }

  #lifecycleQuads(entity: WikibaseEntity, lifecycle: Lifecycle): RDF.Quad[] {
    if (!lifecycle.deletedAt && !lifecycle.redirectTo)
      return buildEntityQuads(entity, this.#options);
    const factory = this.#options.factory ?? new DataFactory();
    const base = this.#options.baseIri.replace(/\/+$/u, '');
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
    editSummary: row.edit_summary,
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

function collectSnak(snak: Snak, used: Map<PropertyId, EntityDatatype>): void {
  const current = used.get(snak.property);
  if (current && current !== snak.datatype)
    throw new PropertyDatatypeMismatchError(
      `Property ${snak.property} is used with multiple datatypes`,
    );
  used.set(snak.property, snak.datatype);
}

function revisionQuad(
  entity: WikibaseEntity,
  options: TaprootOptions,
): RDF.Quad {
  const factory = options.factory ?? new DataFactory();
  const base = options.baseIri.replace(/\/+$/u, '');
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
