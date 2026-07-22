import type {
  SqliteDatabaseLike,
  SqlitePreparedStatementLike,
} from '@gnolith/diamond';
import {
  intersectVisibilityScopes,
  isVisibleTo,
  normalizeAuthorizationContext,
  normalizeVisibilityScope,
  SEARCH_ADMIN_CAPABILITY,
} from './authorization.js';
import {
  canonicalSearchHashV1,
  type SearchProjectionSourceEventV1,
} from './search-contract.js';
import {
  prepareUnifiedSearchSourceEventStatementsV1,
  readPersistedSearchSourceRegistryV1,
} from './search-source-events.js';
import type {
  Attribution,
  AuthorizationContext,
  VisibilityScopeV1,
} from './types.js';

export const RESOURCE_INLINE_TEXT_MAX_BYTES = 65_536;

export type ResourcePayloadV1 =
  | { kind: 'inline-text'; text: string }
  | {
      kind: 'location';
      location: string;
      storage: 'blob' | 'file' | 'url';
      byteLength?: number;
    };

export interface ResourceIntegrityV1 {
  algorithm: 'sha256';
  digest: string;
  byteLength: number;
}

export interface ResourceV1 {
  version: 1;
  id: string;
  itemId: `Q${number}`;
  revision: number;
  title?: string;
  payload: ResourcePayloadV1;
  mediaType: string;
  language?: string;
  integrity: ResourceIntegrityV1;
  attribution: Attribution;
  authorization: {
    installationId: string;
    workspaceId: string | null;
    ownerPrincipalId: string;
    policyRevision: number;
    visibility: VisibilityScopeV1;
  };
  createdAt: string;
  modifiedAt: string;
  deletedAt: string | null;
}

export interface AnnotationSelectorV1 {
  type: string;
  [key: string]: unknown;
}

export type AnnotationBodyV1 =
  | { kind: 'text'; text: string; mediaType?: string; language?: string }
  | { kind: 'resource'; resourceId: string };

export interface AnnotationTargetV1 {
  kind:
    | 'statement'
    | 'item'
    | 'task'
    | 'memory'
    | 'prompt'
    | 'resource'
    | 'annotation';
  sourceId: string;
  selector?: AnnotationSelectorV1;
}

export interface AnnotationV1 {
  version: 1;
  id: string;
  revision: number;
  body: AnnotationBodyV1;
  target: AnnotationTargetV1;
  motivation?: string;
  creator?: Attribution;
  generator?: Attribution;
  language?: string;
  mediaType?: string;
  attribution: Attribution;
  authorization: {
    installationId: string;
    workspaceId: string | null;
    ownerPrincipalId: string;
    policyRevision: number;
    visibility: VisibilityScopeV1;
  };
  createdAt: string;
  modifiedAt: string;
  deletedAt: string | null;
}

export interface WebAnnotationJsonV1 {
  '@context': 'http://www.w3.org/ns/anno.jsonld';
  id: string;
  type: 'Annotation';
  body:
    | {
        type: 'TextualBody';
        value: string;
        format?: string;
        language?: string;
      }
    | { id: string; type: 'SpecificResource' };
  target: {
    source: string;
    type: string;
    selector?: AnnotationSelectorV1;
  };
  motivation?: string;
  creator?: Attribution;
  generator?: Attribution;
  created: string;
  modified: string;
}

export interface PortableResourcePayloadStoreV1 {
  readonly kind: 'taproot-resource-payload-store-v1';
  load(
    reference: Extract<ResourcePayloadV1, { kind: 'location' }>,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}

export interface ContentMutationMetadataV1 {
  context: AuthorizationContext;
  attribution: Attribution;
  workspaceId: string | null;
  ownerPrincipalId: string;
  visibility: VisibilityScopeV1;
  expectedAuthorizationRevision: number;
}

export interface CreateResourceInputV1 {
  id: string;
  itemId: `Q${number}`;
  title?: string;
  payload: ResourcePayloadV1;
  mediaType: string;
  language?: string;
  integrity: ResourceIntegrityV1;
}

export interface CreateAnnotationInputV1 {
  id: string;
  body: AnnotationBodyV1;
  target: AnnotationTargetV1;
  targetVisibility: VisibilityScopeV1;
  motivation?: string;
  creator?: Attribution;
  generator?: Attribution;
  language?: string;
  mediaType?: string;
}

export interface TaprootContentRepositoryOptionsV1 {
  installationId: string;
  clock?: () => Date;
  createId?: () => string;
  payloadStore?: PortableResourcePayloadStoreV1;
}

interface ContentRow {
  record_json: string;
  revision: number;
  deleted_at: string | null;
}

const encoder = new TextEncoder();
const sha256 = /^[0-9a-f]{64}$/u;
const language = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u;
const mediaType =
  /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;[^\r\n]*)?$/u;
const itemId = /^Q[1-9][0-9]*$/u;

export class TaprootContentRepositoryV1 {
  readonly #db: SqliteDatabaseLike;
  readonly #options: {
    installationId: string;
    clock: () => Date;
    createId: () => string;
    payloadStore: PortableResourcePayloadStoreV1 | undefined;
  };

  constructor(
    db: SqliteDatabaseLike,
    options: TaprootContentRepositoryOptionsV1,
  ) {
    this.#db = db;
    this.#options = {
      installationId: token(options.installationId, 'installationId'),
      clock: options.clock ?? (() => new Date()),
      createId: options.createId ?? (() => crypto.randomUUID()),
      payloadStore: options.payloadStore,
    };
  }

  async createResource(
    input: CreateResourceInputV1,
    metadata: ContentMutationMetadataV1,
  ): Promise<ResourceV1> {
    const context = this.#authorizeMutation(metadata);
    const normalized = normalizeResourceInput(input);
    await verifyInlineIntegrity(normalized.payload, normalized.integrity);
    await this.#requireItem(normalized.itemId);
    const existing = await this.#row('taproot_resources', normalized.id);
    if (existing) throw new Error('resource already exists');
    const now = this.#options.clock().toISOString();
    const record: ResourceV1 = {
      version: 1,
      ...normalized,
      revision: 1,
      attribution: normalizeAttribution(metadata.attribution),
      authorization: this.#authorization(metadata, 1),
      createdAt: now,
      modifiedAt: now,
      deletedAt: null,
    };
    await this.#commit('resource', record.id, null, record, 'create', context);
    return clone(record);
  }

  async updateResource(
    id: string,
    expectedRevision: number,
    patch: Partial<Omit<CreateResourceInputV1, 'id' | 'itemId'>>,
    metadata: ContentMutationMetadataV1,
  ): Promise<ResourceV1> {
    const context = this.#authorizeMutation(metadata);
    const current = await this.#resource(id, false);
    if (current.revision !== expectedRevision)
      throw new Error('resource revision conflict');
    const candidate = normalizeResourceInput({
      id: current.id,
      itemId: current.itemId,
      ...((patch.title ?? current.title) === undefined
        ? {}
        : { title: patch.title ?? current.title }),
      payload: patch.payload ?? current.payload,
      mediaType: patch.mediaType ?? current.mediaType,
      ...((patch.language ?? current.language) === undefined
        ? {}
        : { language: patch.language ?? current.language }),
      integrity: patch.integrity ?? current.integrity,
    });
    await verifyInlineIntegrity(candidate.payload, candidate.integrity);
    const record: ResourceV1 = {
      ...current,
      ...candidate,
      revision: current.revision + 1,
      attribution: normalizeAttribution(metadata.attribution),
      authorization: this.#authorization(
        metadata,
        current.authorization.policyRevision + 1,
      ),
      modifiedAt: this.#options.clock().toISOString(),
    };
    await this.#commit(
      'resource',
      record.id,
      current,
      record,
      'update',
      context,
    );
    return clone(record);
  }

  async deleteResource(
    id: string,
    expectedRevision: number,
    metadata: ContentMutationMetadataV1,
  ): Promise<ResourceV1> {
    const context = this.#authorizeMutation(metadata);
    const current = await this.#resource(id, false);
    if (current.revision !== expectedRevision)
      throw new Error('resource revision conflict');
    const record: ResourceV1 = {
      ...current,
      revision: current.revision + 1,
      attribution: normalizeAttribution(metadata.attribution),
      authorization: this.#authorization(
        metadata,
        current.authorization.policyRevision + 1,
      ),
      modifiedAt: this.#options.clock().toISOString(),
      deletedAt: this.#options.clock().toISOString(),
    };
    await this.#commit(
      'resource',
      record.id,
      current,
      record,
      'delete',
      context,
    );
    return clone(record);
  }

  async getResource(
    id: string,
    context: AuthorizationContext,
  ): Promise<ResourceV1> {
    const record = await this.#resource(id, false);
    this.#authorizeRead(
      record.authorization.installationId,
      record.authorization.visibility,
      context,
    );
    return clone(record);
  }

  async getResourceRevision(
    id: string,
    revision: number,
    context: AuthorizationContext,
  ): Promise<ResourceV1> {
    const record = await this.#revision<ResourceV1>('resource', id, revision);
    this.#authorizeRead(
      record.authorization.installationId,
      record.authorization.visibility,
      context,
    );
    return clone(record);
  }

  async hydrateResourcePayload(
    id: string,
    context: AuthorizationContext,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const resource = await this.getResource(id, context);
    if (resource.payload.kind === 'inline-text')
      return encoder.encode(resource.payload.text);
    if (!this.#options.payloadStore)
      throw new Error('resource payload store is unavailable');
    const bytes = await this.#options.payloadStore.load(
      resource.payload,
      signal,
    );
    if (bytes.byteLength !== resource.integrity.byteLength)
      throw new Error('resource payload length mismatch');
    const digest = await digestBytes(bytes);
    if (digest !== resource.integrity.digest)
      throw new Error('resource payload integrity mismatch');
    return bytes;
  }

  async createAnnotation(
    input: CreateAnnotationInputV1,
    metadata: ContentMutationMetadataV1,
  ): Promise<AnnotationV1> {
    const context = this.#authorizeMutation(metadata);
    const normalized = normalizeAnnotationInput(input);
    const existing = await this.#row('taproot_annotations', normalized.id);
    if (existing) throw new Error('annotation already exists');
    if (normalized.body.kind === 'resource')
      await this.#resource(normalized.body.resourceId, false);
    const now = this.#options.clock().toISOString();
    const inherited = intersectVisibilityScopes(
      normalizeVisibilityScope(input.targetVisibility),
      normalizeVisibilityScope(metadata.visibility),
    );
    const record: AnnotationV1 = {
      version: 1,
      ...normalized,
      revision: 1,
      attribution: normalizeAttribution(metadata.attribution),
      authorization: {
        ...this.#authorization(metadata, 1),
        visibility: inherited,
      },
      createdAt: now,
      modifiedAt: now,
      deletedAt: null,
    };
    await this.#commit(
      'annotation',
      record.id,
      null,
      record,
      'create',
      context,
    );
    return clone(record);
  }

  async updateAnnotation(
    id: string,
    expectedRevision: number,
    input: CreateAnnotationInputV1,
    metadata: ContentMutationMetadataV1,
  ): Promise<AnnotationV1> {
    const context = this.#authorizeMutation(metadata);
    const current = await this.#annotation(id, false);
    if (current.revision !== expectedRevision)
      throw new Error('annotation revision conflict');
    const normalized = normalizeAnnotationInput({ ...input, id: current.id });
    if (normalized.body.kind === 'resource')
      await this.#resource(normalized.body.resourceId, false);
    const record: AnnotationV1 = {
      ...current,
      ...normalized,
      revision: current.revision + 1,
      attribution: normalizeAttribution(metadata.attribution),
      authorization: {
        ...this.#authorization(
          metadata,
          current.authorization.policyRevision + 1,
        ),
        visibility: intersectVisibilityScopes(
          normalizeVisibilityScope(input.targetVisibility),
          normalizeVisibilityScope(metadata.visibility),
        ),
      },
      modifiedAt: this.#options.clock().toISOString(),
    };
    await this.#commit(
      'annotation',
      record.id,
      current,
      record,
      'update',
      context,
    );
    return clone(record);
  }

  async deleteAnnotation(
    id: string,
    expectedRevision: number,
    metadata: ContentMutationMetadataV1,
  ): Promise<AnnotationV1> {
    const context = this.#authorizeMutation(metadata);
    const current = await this.#annotation(id, false);
    if (current.revision !== expectedRevision)
      throw new Error('annotation revision conflict');
    const record: AnnotationV1 = {
      ...current,
      revision: current.revision + 1,
      attribution: normalizeAttribution(metadata.attribution),
      authorization: this.#authorization(
        metadata,
        current.authorization.policyRevision + 1,
      ),
      modifiedAt: this.#options.clock().toISOString(),
      deletedAt: this.#options.clock().toISOString(),
    };
    await this.#commit(
      'annotation',
      record.id,
      current,
      record,
      'delete',
      context,
    );
    return clone(record);
  }

  async getAnnotation(
    id: string,
    context: AuthorizationContext,
  ): Promise<AnnotationV1> {
    const record = await this.#annotation(id, false);
    this.#authorizeRead(
      record.authorization.installationId,
      record.authorization.visibility,
      context,
    );
    return clone(record);
  }

  async getAnnotationRevision(
    id: string,
    revision: number,
    context: AuthorizationContext,
  ): Promise<AnnotationV1> {
    const record = await this.#revision<AnnotationV1>(
      'annotation',
      id,
      revision,
    );
    this.#authorizeRead(
      record.authorization.installationId,
      record.authorization.visibility,
      context,
    );
    return clone(record);
  }

  async exportContent(context: AuthorizationContext): Promise<{
    version: 1;
    resources: ResourceV1[];
    annotations: AnnotationV1[];
  }> {
    const normalized = normalizeAuthorizationContext(context);
    const resources = await this.#all<ResourceV1>('taproot_resources');
    const annotations = await this.#all<AnnotationV1>('taproot_annotations');
    return {
      version: 1,
      resources: resources
        .filter(
          (record) =>
            record.deletedAt === null &&
            this.#visible(record.authorization, normalized),
        )
        .map(clone),
      annotations: annotations
        .filter(
          (record) =>
            record.deletedAt === null &&
            this.#visible(record.authorization, normalized),
        )
        .map(clone),
    };
  }

  async importContent(
    snapshot: {
      version: 1;
      resources: ResourceV1[];
      annotations: AnnotationV1[];
    },
    context: AuthorizationContext,
  ): Promise<void> {
    const normalized = normalizeAuthorizationContext(context);
    if (!normalized.capabilities.includes(SEARCH_ADMIN_CAPABILITY))
      throw new Error('search:admin is required');
    if (
      snapshot.version !== 1 ||
      !Array.isArray(snapshot.resources) ||
      !Array.isArray(snapshot.annotations)
    )
      throw new Error('invalid content snapshot');
    const statements: SqlitePreparedStatementLike[] = [];
    for (const resource of snapshot.resources) {
      const record = normalizeImportedResource(
        resource,
        this.#options.installationId,
      );
      statements.push(
        this.#upsertCurrent('resource', record.id, record),
        this.#insertRevision('resource', record.id, record),
      );
    }
    for (const annotation of snapshot.annotations) {
      const record = normalizeImportedAnnotation(
        annotation,
        this.#options.installationId,
      );
      statements.push(
        this.#upsertCurrent('annotation', record.id, record),
        this.#insertRevision('annotation', record.id, record),
      );
    }
    if (statements.length) await this.#db.batch(statements);
  }

  async projectionSource(
    kind: 'resource' | 'annotation',
    id: string,
  ): Promise<SearchProjectionSourceEventV1> {
    const record =
      kind === 'resource'
        ? await this.#resource(id, false)
        : await this.#annotation(id, false);
    const registry = await readPersistedSearchSourceRegistryV1(
      this.#db,
      this.#options.installationId,
      kind,
      id,
    );
    if (!registry) throw new Error('content search source is missing');
    return {
      version: 1,
      eventId: registry.eventId,
      operation: 'upsert',
      installationId: this.#options.installationId,
      kind,
      sourceId: id,
      sourceRevision: String(record.revision),
      sourceHash: await canonicalSearchHashV1(record),
      sourcePolicyRevision: record.authorization.policyRevision,
      authorizationRevision: record.authorization.policyRevision,
      searchGeneration: registry.searchGeneration,
    };
  }

  async #commit(
    kind: 'resource' | 'annotation',
    id: string,
    previous: ResourceV1 | AnnotationV1 | null,
    record: ResourceV1 | AnnotationV1,
    eventType: string,
    context: AuthorizationContext,
  ): Promise<void> {
    const hash = await canonicalSearchHashV1(record);
    const predecessor = await readPersistedSearchSourceRegistryV1(
      this.#db,
      this.#options.installationId,
      kind,
      id,
    );
    const fenceResult = await this.#db
      .prepare(
        `SELECT authorization_revision, search_generation FROM taproot_installation_authorization WHERE installation_id = ?`,
      )
      .bind(this.#options.installationId)
      .all<{ authorization_revision: number; search_generation: number }>();
    const fence = fenceResult.results[0];
    if (
      !fence ||
      Number(fence.authorization_revision) !== context.authorizationRevision
    )
      throw new Error('authorization fence is stale');
    const nextAuthorizationRevision = Number(fence.authorization_revision) + 1;
    const nextSearchGeneration = Number(fence.search_generation) + 1;
    const eventId = token(this.#options.createId(), 'eventId');
    const now = this.#options.clock().toISOString();
    const event = await prepareUnifiedSearchSourceEventStatementsV1(
      this.#db,
      {
        installationId: this.#options.installationId,
        domain: 'taproot',
        sourceKind: kind,
        sourcePolicyRevision: record.authorization.policyRevision,
        authorizationRevision: nextAuthorizationRevision,
        searchGeneration: nextSearchGeneration,
        createdAt: now,
      },
      {
        eventId,
        sourceId: id,
        operation: record.deletedAt ? 'delete' : 'upsert',
        changeClass: eventType,
        sourceRevision: String(record.revision),
        sourceHash: hash,
        predecessor: predecessor
          ? { eventId: predecessor.eventId, sequence: predecessor.sequence }
          : null,
      },
      ['create', 'update', 'delete', 'restore', 'import'],
    );
    await this.#db.batch([
      this.#upsertCurrent(kind, id, record),
      this.#insertRevision(kind, id, record),
      this.#db
        .prepare(
          `UPDATE taproot_installation_authorization
           SET authorization_revision = ?, search_generation = ?,
               last_advance_id = ?, updated_at = ?
           WHERE installation_id = ? AND authorization_revision = ?`,
        )
        .bind(
          nextAuthorizationRevision,
          nextSearchGeneration,
          eventId,
          now,
          this.#options.installationId,
          context.authorizationRevision,
        ),
      this.#db
        .prepare(
          `INSERT INTO taproot_installation_authorization_advances(
             advance_id, installation_id, from_revision, to_revision,
             search_generation, domain, principal_id, reason, created_at
           ) VALUES (?, ?, ?, ?, ?, 'taproot-content', ?, ?, ?)`,
        )
        .bind(
          eventId,
          this.#options.installationId,
          context.authorizationRevision,
          nextAuthorizationRevision,
          nextSearchGeneration,
          context.principalId,
          `${kind}:${eventType}`,
          now,
        ),
      this.#db
        .prepare(
          `INSERT INTO taproot_content_audit(audit_id, installation_id, record_kind, record_id, revision, event_type, principal_id, attribution_json, record_hash, previous_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          eventId,
          this.#options.installationId,
          kind,
          id,
          record.revision,
          eventType,
          context.principalId,
          JSON.stringify(record.attribution),
          hash,
          previous ? await canonicalSearchHashV1(previous) : null,
          now,
        ),
      ...event.statements,
    ]);
  }

  #upsertCurrent(
    kind: 'resource' | 'annotation',
    id: string,
    record: ResourceV1 | AnnotationV1,
  ): SqlitePreparedStatementLike {
    const table =
      kind === 'resource' ? 'taproot_resources' : 'taproot_annotations';
    return this.#db
      .prepare(
        `INSERT INTO ${table}(record_id, installation_id, revision, record_json, policy_revision, visibility_json, deleted_at, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(record_id) DO UPDATE SET revision=excluded.revision, record_json=excluded.record_json, policy_revision=excluded.policy_revision, visibility_json=excluded.visibility_json, deleted_at=excluded.deleted_at, modified_at=excluded.modified_at WHERE excluded.revision > ${table}.revision`,
      )
      .bind(
        id,
        this.#options.installationId,
        record.revision,
        JSON.stringify(record),
        record.authorization.policyRevision,
        JSON.stringify(record.authorization.visibility),
        record.deletedAt,
        record.createdAt,
        record.modifiedAt,
      );
  }

  #insertRevision(
    kind: 'resource' | 'annotation',
    id: string,
    record: ResourceV1 | AnnotationV1,
  ): SqlitePreparedStatementLike {
    return this.#db
      .prepare(
        `INSERT INTO taproot_content_revisions(record_kind, record_id, revision, record_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(record_kind, record_id, revision) DO NOTHING`,
      )
      .bind(
        kind,
        id,
        record.revision,
        JSON.stringify(record),
        record.modifiedAt,
      );
  }

  async #resource(id: string, includeDeleted: boolean): Promise<ResourceV1> {
    const row = await this.#row('taproot_resources', token(id, 'resourceId'));
    if (!row || (!includeDeleted && row.deleted_at))
      throw new Error('resource not found');
    return normalizeImportedResource(
      JSON.parse(row.record_json) as ResourceV1,
      this.#options.installationId,
    );
  }

  async #annotation(
    id: string,
    includeDeleted: boolean,
  ): Promise<AnnotationV1> {
    const row = await this.#row(
      'taproot_annotations',
      token(id, 'annotationId'),
    );
    if (!row || (!includeDeleted && row.deleted_at))
      throw new Error('annotation not found');
    return normalizeImportedAnnotation(
      JSON.parse(row.record_json) as AnnotationV1,
      this.#options.installationId,
    );
  }

  async #row(
    table: 'taproot_resources' | 'taproot_annotations',
    id: string,
  ): Promise<ContentRow | undefined> {
    const result = await this.#db
      .prepare(
        `SELECT record_json, revision, deleted_at FROM ${table} WHERE record_id = ? AND installation_id = ?`,
      )
      .bind(id, this.#options.installationId)
      .all<ContentRow>();
    return result.results[0];
  }

  async #revision<T>(
    kind: 'resource' | 'annotation',
    id: string,
    revision: number,
  ): Promise<T> {
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw new Error('invalid revision');
    const result = await this.#db
      .prepare(
        `SELECT record_json FROM taproot_content_revisions WHERE record_kind = ? AND record_id = ? AND revision = ?`,
      )
      .bind(kind, token(id, `${kind}Id`), revision)
      .all<{ record_json: string }>();
    if (!result.results[0]) throw new Error(`${kind} revision not found`);
    return JSON.parse(result.results[0].record_json) as T;
  }

  async #all<T>(
    table: 'taproot_resources' | 'taproot_annotations',
  ): Promise<T[]> {
    const result = await this.#db
      .prepare(
        `SELECT record_json FROM ${table} WHERE installation_id = ? ORDER BY record_id`,
      )
      .bind(this.#options.installationId)
      .all<{ record_json: string }>();
    return result.results.map((row) => JSON.parse(row.record_json) as T);
  }

  async #requireItem(id: string): Promise<void> {
    const result = await this.#db
      .prepare(
        `SELECT 1 AS found FROM taproot_entities WHERE entity_id = ? AND entity_type = 'item' AND deleted_at IS NULL`,
      )
      .bind(id)
      .all<{ found: number }>();
    if (!result.results.length) throw new Error('resource item not found');
  }

  #authorizeMutation(
    metadata: ContentMutationMetadataV1,
  ): AuthorizationContext {
    const context = normalizeAuthorizationContext(metadata.context);
    if (context.installationId !== this.#options.installationId)
      throw new Error('installation mismatch');
    if (
      metadata.expectedAuthorizationRevision !== context.authorizationRevision
    )
      throw new Error('authorization revision mismatch');
    if (
      metadata.workspaceId !== null &&
      !context.workspaceIds.includes(metadata.workspaceId)
    )
      throw new Error('workspace authorization denied');
    if (
      metadata.ownerPrincipalId !== context.principalId &&
      !context.capabilities.includes(SEARCH_ADMIN_CAPABILITY)
    )
      throw new Error('owner authorization denied');
    normalizeVisibilityScope(metadata.visibility);
    normalizeAttribution(metadata.attribution);
    return context;
  }

  #authorization(metadata: ContentMutationMetadataV1, policyRevision: number) {
    return {
      installationId: this.#options.installationId,
      workspaceId: metadata.workspaceId,
      ownerPrincipalId: token(metadata.ownerPrincipalId, 'ownerPrincipalId'),
      policyRevision,
      visibility: normalizeVisibilityScope(metadata.visibility),
    };
  }

  #authorizeRead(
    installationId: string,
    visibility: VisibilityScopeV1,
    context: AuthorizationContext,
  ): void {
    const normalized = normalizeAuthorizationContext(context);
    if (
      normalized.installationId !== installationId ||
      !isVisibleTo(visibility, normalized)
    )
      throw new Error('authorization denied');
  }

  #visible(
    authorization: ResourceV1['authorization'],
    context: AuthorizationContext,
  ): boolean {
    return (
      authorization.installationId === context.installationId &&
      isVisibleTo(authorization.visibility, context)
    );
  }
}

export function exportWebAnnotationV1(
  annotation: AnnotationV1,
): WebAnnotationJsonV1 {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    id: annotation.id,
    type: 'Annotation',
    body:
      annotation.body.kind === 'text'
        ? {
            type: 'TextualBody',
            value: annotation.body.text,
            ...(annotation.body.mediaType === undefined
              ? {}
              : { format: annotation.body.mediaType }),
            ...(annotation.body.language === undefined
              ? {}
              : { language: annotation.body.language }),
          }
        : { id: annotation.body.resourceId, type: 'SpecificResource' },
    target: {
      source: annotation.target.sourceId,
      type: annotation.target.kind,
      ...(annotation.target.selector === undefined
        ? {}
        : { selector: clone(annotation.target.selector) }),
    },
    ...(annotation.motivation === undefined
      ? {}
      : { motivation: annotation.motivation }),
    ...(annotation.creator === undefined
      ? {}
      : { creator: clone(annotation.creator) }),
    ...(annotation.generator === undefined
      ? {}
      : { generator: clone(annotation.generator) }),
    created: annotation.createdAt,
    modified: annotation.modifiedAt,
  };
}

export function importWebAnnotationV1(
  value: WebAnnotationJsonV1,
  targetVisibility: VisibilityScopeV1,
): CreateAnnotationInputV1 {
  if (
    value['@context'] !== 'http://www.w3.org/ns/anno.jsonld' ||
    value.type !== 'Annotation'
  )
    throw new Error('unsupported Web Annotation document');
  const body: AnnotationBodyV1 =
    value.body.type === 'TextualBody'
      ? {
          kind: 'text',
          text: value.body.value,
          ...(value.body.format === undefined
            ? {}
            : { mediaType: value.body.format }),
          ...(value.body.language === undefined
            ? {}
            : { language: value.body.language }),
        }
      : { kind: 'resource', resourceId: value.body.id };
  return {
    id: value.id,
    body,
    target: normalizeTarget({
      kind: value.target.type as AnnotationTargetV1['kind'],
      sourceId: value.target.source,
      ...(value.target.selector === undefined
        ? {}
        : { selector: value.target.selector }),
    }),
    targetVisibility: normalizeVisibilityScope(targetVisibility),
    ...(value.motivation === undefined ? {} : { motivation: value.motivation }),
    ...(value.creator === undefined ? {} : { creator: value.creator }),
    ...(value.generator === undefined ? {} : { generator: value.generator }),
  };
}

function normalizeResourceInput(
  input: CreateResourceInputV1,
): Omit<
  ResourceV1,
  | 'version'
  | 'revision'
  | 'attribution'
  | 'authorization'
  | 'createdAt'
  | 'modifiedAt'
  | 'deletedAt'
> {
  const id = token(input.id, 'resourceId');
  if (!itemId.test(input.itemId)) throw new Error('invalid resource itemId');
  const title =
    input.title === undefined
      ? undefined
      : boundedText(input.title, 'title', 4096);
  const payload = normalizePayload(input.payload);
  if (!mediaType.test(input.mediaType)) throw new Error('invalid mediaType');
  const lang =
    input.language === undefined
      ? undefined
      : normalizeLanguage(input.language);
  const integrity = normalizeIntegrity(input.integrity);
  if (payload.kind === 'inline-text') {
    const bytes = encoder.encode(payload.text);
    if (bytes.byteLength !== integrity.byteLength)
      throw new Error('inline payload length mismatch');
  }
  return {
    id,
    itemId: input.itemId,
    ...(title === undefined ? {} : { title }),
    payload,
    mediaType: input.mediaType,
    ...(lang === undefined ? {} : { language: lang }),
    integrity,
  };
}

function normalizeAnnotationInput(
  input: CreateAnnotationInputV1,
): Omit<
  AnnotationV1,
  | 'version'
  | 'revision'
  | 'attribution'
  | 'authorization'
  | 'createdAt'
  | 'modifiedAt'
  | 'deletedAt'
> {
  const id = token(input.id, 'annotationId');
  const body = normalizeBody(input.body);
  const target = normalizeTarget(input.target);
  const motivation =
    input.motivation === undefined
      ? undefined
      : token(input.motivation, 'motivation');
  const creator =
    input.creator === undefined
      ? undefined
      : normalizeAttribution(input.creator);
  const generator =
    input.generator === undefined
      ? undefined
      : normalizeAttribution(input.generator);
  const lang =
    input.language === undefined
      ? undefined
      : normalizeLanguage(input.language);
  const type = input.mediaType === undefined ? undefined : input.mediaType;
  if (type !== undefined && !mediaType.test(type))
    throw new Error('invalid annotation mediaType');
  return {
    id,
    body,
    target,
    ...(motivation === undefined ? {} : { motivation }),
    ...(creator === undefined ? {} : { creator }),
    ...(generator === undefined ? {} : { generator }),
    ...(lang === undefined ? {} : { language: lang }),
    ...(type === undefined ? {} : { mediaType: type }),
  };
}

function normalizePayload(payload: ResourcePayloadV1): ResourcePayloadV1 {
  if (!payload || typeof payload !== 'object')
    throw new Error('invalid resource payload');
  if (payload.kind === 'inline-text')
    return {
      kind: 'inline-text',
      text: boundedText(
        payload.text,
        'payload.text',
        RESOURCE_INLINE_TEXT_MAX_BYTES,
      ),
    };
  if (
    payload.kind !== 'location' ||
    !['blob', 'file', 'url'].includes(payload.storage)
  )
    throw new Error('invalid resource location');
  const location = boundedText(payload.location, 'payload.location', 8192);
  if (payload.storage === 'url') {
    const url = new URL(location);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error('invalid resource URL');
  }
  if (
    payload.byteLength !== undefined &&
    (!Number.isSafeInteger(payload.byteLength) || payload.byteLength < 0)
  )
    throw new Error('invalid payload byteLength');
  return {
    kind: 'location',
    location,
    storage: payload.storage,
    ...(payload.byteLength === undefined
      ? {}
      : { byteLength: payload.byteLength }),
  };
}

function normalizeBody(body: AnnotationBodyV1): AnnotationBodyV1 {
  if (!body || typeof body !== 'object')
    throw new Error('invalid annotation body');
  if (body.kind === 'resource')
    return {
      kind: 'resource',
      resourceId: token(body.resourceId, 'resourceId'),
    };
  if (body.kind !== 'text') throw new Error('invalid annotation body');
  const text = boundedText(
    body.text,
    'body.text',
    RESOURCE_INLINE_TEXT_MAX_BYTES,
  );
  if (body.mediaType !== undefined && !mediaType.test(body.mediaType))
    throw new Error('invalid body mediaType');
  return {
    kind: 'text',
    text,
    ...(body.mediaType === undefined ? {} : { mediaType: body.mediaType }),
    ...(body.language === undefined
      ? {}
      : { language: normalizeLanguage(body.language) }),
  };
}

function normalizeTarget(target: AnnotationTargetV1): AnnotationTargetV1 {
  if (
    !target ||
    typeof target !== 'object' ||
    ![
      'statement',
      'item',
      'task',
      'memory',
      'prompt',
      'resource',
      'annotation',
    ].includes(target.kind)
  )
    throw new Error('invalid annotation target');
  const selector =
    target.selector === undefined
      ? undefined
      : (JSON.parse(JSON.stringify(target.selector)) as AnnotationSelectorV1);
  if (
    selector !== undefined &&
    (typeof selector !== 'object' || typeof selector.type !== 'string')
  )
    throw new Error('invalid annotation selector');
  return {
    kind: target.kind,
    sourceId: token(target.sourceId, 'target.sourceId'),
    ...(selector === undefined ? {} : { selector }),
  };
}

function normalizeIntegrity(value: ResourceIntegrityV1): ResourceIntegrityV1 {
  if (
    value.algorithm !== 'sha256' ||
    !sha256.test(value.digest) ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 0
  )
    throw new Error('invalid resource integrity');
  return {
    algorithm: 'sha256',
    digest: value.digest,
    byteLength: value.byteLength,
  };
}

function normalizeImportedResource(
  value: ResourceV1,
  installationId: string,
): ResourceV1 {
  if (
    value.version !== 1 ||
    value.authorization.installationId !== installationId
  )
    throw new Error('invalid imported resource');
  normalizeResourceInput(value);
  normalizeVisibilityScope(value.authorization.visibility);
  return clone(value);
}

function normalizeImportedAnnotation(
  value: AnnotationV1,
  installationId: string,
): AnnotationV1 {
  if (
    value.version !== 1 ||
    value.authorization.installationId !== installationId
  )
    throw new Error('invalid imported annotation');
  normalizeAnnotationInput({
    ...value,
    targetVisibility: value.authorization.visibility,
  });
  normalizeVisibilityScope(value.authorization.visibility);
  return clone(value);
}

function normalizeAttribution(value: Attribution): Attribution {
  if (
    !value ||
    typeof value !== 'object' ||
    !['human', 'agent', 'import', 'system'].includes(value.kind)
  )
    throw new Error('invalid attribution');
  return { ...value, id: token(value.id, 'attribution.id') };
}

function token(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error(`${name} is invalid`);
  return value;
}

function boundedText(value: unknown, name: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    encoder.encode(value).byteLength > maxBytes
  )
    throw new Error(`${name} is invalid`);
  return value;
}

function normalizeLanguage(value: string): string {
  if (!language.test(value)) throw new Error('invalid language');
  return value.toLowerCase();
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const copy = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const hash = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(hash)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function verifyInlineIntegrity(
  payload: ResourcePayloadV1,
  integrity: ResourceIntegrityV1,
): Promise<void> {
  if (payload.kind !== 'inline-text') return;
  if ((await digestBytes(encoder.encode(payload.text))) !== integrity.digest)
    throw new Error('inline payload integrity mismatch');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
