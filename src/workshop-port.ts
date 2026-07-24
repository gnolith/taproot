import {
  createAuthorizationCursorCodec,
  createAuthorizedTaproot,
  isVisibleTo,
  normalizeAuthorizationContext,
} from './authorization.js';
import {
  assertTaprootHostWriteCapabilityInternal,
  type TaprootHostWriteCapability,
} from './assembly-authority.js';
import {
  type CreateAnnotationInputV1,
  type CreateResourceInputV1,
  type PortableResourcePayloadStoreV1,
  TaprootContentRepositoryV1,
  type AnnotationV1,
  type ResourceV1,
} from './content-domain.js';
import { AuthorizationDeniedError, InvalidCursorError } from './errors.js';
import { TaprootRepository } from './repository.js';
import { canonicalSearchHashV1 } from './search-contract.js';
import type { D1DatabaseLike } from './sqlite-types.js';
import type {
  AuthorizationContext,
  EntityCommand,
  EntityId,
  Page,
  RevisionEntry,
  Statement,
  TaprootOptions,
  VisibilityScopeV1,
  WriteResult,
} from './types.js';
import type { CreateItemInput, CreatePropertyInput } from './repository.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_MAX_HYDRATED_RESOURCE_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface TaprootWorkshopHistoryOptionsV1 {
  limit?: number;
  cursor?: string;
}

export interface TaprootWorkshopStatementRevisionV1 {
  version: 1;
  entityId: EntityId;
  entityRevision: number;
  statement: Statement;
  revision: RevisionEntry;
}

export interface TaprootWorkshopPrincipalV1 {
  principalId: string;
  activeWorkspaceId?: string | null;
}

export interface TaprootWorkshopMutationOptionsV1 {
  idempotencyKey: string;
}

export interface TaprootWorkshopEntityMutationOptionsV1 extends TaprootWorkshopMutationOptionsV1 {
  expectedRevision: number;
}

export interface TaprootWorkshopEntityMutationV1 {
  command: EntityCommand;
  authoredText: string;
}

export interface TaprootWorkshopPortV1 {
  readonly kind: 'taproot-workshop-port-v1';
  resolveAuthorization(
    principal: TaprootWorkshopPrincipalV1,
  ): Promise<AuthorizationContext>;
  statementHistory(
    statementId: string,
    options: TaprootWorkshopHistoryOptionsV1,
    context: AuthorizationContext,
  ): Promise<Page<TaprootWorkshopStatementRevisionV1>>;
  statementRevision(
    statementId: string,
    revision: number,
    context: AuthorizationContext,
  ): Promise<TaprootWorkshopStatementRevisionV1>;
  resourceHistory(
    resourceId: string,
    options: TaprootWorkshopHistoryOptionsV1,
    context: AuthorizationContext,
  ): Promise<Page<ResourceV1>>;
  resourceRevision(
    resourceId: string,
    revision: number,
    context: AuthorizationContext,
  ): Promise<ResourceV1>;
  hydrateResource(
    resourceId: string,
    revision: number,
    context: AuthorizationContext,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  annotationHistory(
    annotationId: string,
    options: TaprootWorkshopHistoryOptionsV1,
    context: AuthorizationContext,
  ): Promise<Page<AnnotationV1>>;
  annotationRevision(
    annotationId: string,
    revision: number,
    context: AuthorizationContext,
  ): Promise<AnnotationV1>;
  createItem(
    input: Omit<CreateItemInput, 'authorization' | 'authorizationContext'>,
    options: TaprootWorkshopMutationOptionsV1,
    context: AuthorizationContext,
  ): Promise<WriteResult>;
  createProperty(
    input: Omit<CreatePropertyInput, 'authorization' | 'authorizationContext'>,
    options: TaprootWorkshopMutationOptionsV1,
    context: AuthorizationContext,
  ): Promise<WriteResult>;
  mutateEntity(
    entityId: EntityId,
    mutations: readonly TaprootWorkshopEntityMutationV1[],
    options: TaprootWorkshopEntityMutationOptionsV1,
    context: AuthorizationContext,
  ): Promise<WriteResult>;
  createResource(
    input: CreateResourceInputV1,
    options: TaprootWorkshopMutationOptionsV1,
    context: AuthorizationContext,
  ): Promise<ResourceV1>;
  updateResource(
    resourceId: string,
    expectedRevision: number,
    input: CreateResourceInputV1,
    options: TaprootWorkshopMutationOptionsV1,
    context: AuthorizationContext,
  ): Promise<ResourceV1>;
  deleteResource(
    resourceId: string,
    expectedRevision: number,
    options: TaprootWorkshopMutationOptionsV1,
    context: AuthorizationContext,
  ): Promise<ResourceV1>;
  createAnnotation(
    input: CreateAnnotationInputV1,
    options: TaprootWorkshopMutationOptionsV1,
    context: AuthorizationContext,
  ): Promise<AnnotationV1>;
  updateAnnotation(
    annotationId: string,
    expectedRevision: number,
    input: CreateAnnotationInputV1,
    options: TaprootWorkshopMutationOptionsV1,
    context: AuthorizationContext,
  ): Promise<AnnotationV1>;
  deleteAnnotation(
    annotationId: string,
    expectedRevision: number,
    options: TaprootWorkshopMutationOptionsV1,
    context: AuthorizationContext,
  ): Promise<AnnotationV1>;
}

export async function createTaprootWorkshopPortV1(
  db: D1DatabaseLike,
  options: TaprootOptions,
  authority: TaprootHostWriteCapability,
  input: {
    installationId: string;
    payloadStore?: PortableResourcePayloadStoreV1;
    maxHydratedResourceBytes?: number;
  },
): Promise<TaprootWorkshopPortV1> {
  assertTaprootHostWriteCapabilityInternal(db, options, authority);
  const installationId = identifier(input?.installationId, 'installationId');
  const cursorKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const cursorCodec = createAuthorizationCursorCodec(cursorKey);
  const maxHydratedResourceBytes =
    input.maxHydratedResourceBytes === undefined
      ? DEFAULT_MAX_HYDRATED_RESOURCE_BYTES
      : positiveInteger(
          input.maxHydratedResourceBytes,
          'maxHydratedResourceBytes',
        );
  const content = new TaprootContentRepositoryV1(db, {
    installationId,
    ...(input.payloadStore ? { payloadStore: input.payloadStore } : {}),
  });
  const runtime = new WorkshopPortRuntime(
    db,
    options,
    installationId,
    maxHydratedResourceBytes,
    cursorKey,
    cursorCodec,
    content,
  );
  const port: TaprootWorkshopPortV1 = {
    kind: 'taproot-workshop-port-v1' as const,
    resolveAuthorization: (principal: TaprootWorkshopPrincipalV1) =>
      runtime.resolveAuthorization(principal),
    statementHistory: (
      statementId: string,
      page: TaprootWorkshopHistoryOptionsV1,
      context: AuthorizationContext,
    ) => runtime.statementHistory(statementId, page, context),
    statementRevision: (
      statementId: string,
      revision: number,
      context: AuthorizationContext,
    ) => runtime.statementRevision(statementId, revision, context),
    resourceHistory: (
      resourceId: string,
      page: TaprootWorkshopHistoryOptionsV1,
      context: AuthorizationContext,
    ) => runtime.contentHistory('resource', resourceId, page, context),
    resourceRevision: (
      resourceId: string,
      revision: number,
      context: AuthorizationContext,
    ) => runtime.contentRevision('resource', resourceId, revision, context),
    hydrateResource: (resourceId, revision, context, signal) =>
      runtime.hydrateResource(resourceId, revision, context, signal),
    annotationHistory: (
      annotationId: string,
      page: TaprootWorkshopHistoryOptionsV1,
      context: AuthorizationContext,
    ) => runtime.contentHistory('annotation', annotationId, page, context),
    annotationRevision: (
      annotationId: string,
      revision: number,
      context: AuthorizationContext,
    ) => runtime.contentRevision('annotation', annotationId, revision, context),
    createItem: (item, mutation, context) =>
      runtime.createEntity('item', item, mutation, context),
    createProperty: (property, mutation, context) =>
      runtime.createEntity('property', property, mutation, context),
    mutateEntity: (entityId, mutations, mutation, context) =>
      runtime.mutateEntity(entityId, mutations, mutation, context),
    createResource: (resource, mutation, context) =>
      runtime.createContent('resource', resource, mutation, context),
    updateResource: (
      resourceId,
      expectedRevision,
      resource,
      mutation,
      context,
    ) =>
      runtime.updateContent(
        'resource',
        resourceId,
        expectedRevision,
        resource,
        mutation,
        context,
      ),
    deleteResource: (resourceId, expectedRevision, mutation, context) =>
      runtime.deleteContent(
        'resource',
        resourceId,
        expectedRevision,
        mutation,
        context,
      ),
    createAnnotation: (annotation, mutation, context) =>
      runtime.createContent('annotation', annotation, mutation, context),
    updateAnnotation: (
      annotationId,
      expectedRevision,
      annotation,
      mutation,
      context,
    ) =>
      runtime.updateContent(
        'annotation',
        annotationId,
        expectedRevision,
        annotation,
        mutation,
        context,
      ),
    deleteAnnotation: (annotationId, expectedRevision, mutation, context) =>
      runtime.deleteContent(
        'annotation',
        annotationId,
        expectedRevision,
        mutation,
        context,
      ),
  };
  return Object.freeze(port);
}

class WorkshopPortRuntime {
  readonly #db: D1DatabaseLike;
  readonly #options: TaprootOptions;
  readonly #installationId: string;
  readonly #maxHydratedResourceBytes: number;
  readonly #cursorKey: CryptoKey;
  readonly #cursorCodec: ReturnType<typeof createAuthorizationCursorCodec>;
  readonly #content: TaprootContentRepositoryV1;
  readonly #repository: TaprootRepository;
  readonly #mutationLocks = new Map<string, Promise<void>>();

  constructor(
    db: D1DatabaseLike,
    options: TaprootOptions,
    installationId: string,
    maxHydratedResourceBytes: number,
    cursorKey: CryptoKey,
    cursorCodec: ReturnType<typeof createAuthorizationCursorCodec>,
    content: TaprootContentRepositoryV1,
  ) {
    this.#db = db;
    this.#options = options;
    this.#installationId = installationId;
    this.#maxHydratedResourceBytes = maxHydratedResourceBytes;
    this.#cursorKey = cursorKey;
    this.#cursorCodec = cursorCodec;
    this.#content = content;
    this.#repository = new TaprootRepository(db, options);
  }

  async createEntity(
    kind: 'item',
    input: Omit<CreateItemInput, 'authorization' | 'authorizationContext'>,
    options: TaprootWorkshopMutationOptionsV1,
    context: AuthorizationContext,
  ): Promise<WriteResult>;
  async createEntity(
    kind: 'property',
    input: Omit<CreatePropertyInput, 'authorization' | 'authorizationContext'>,
    options: TaprootWorkshopMutationOptionsV1,
    context: AuthorizationContext,
  ): Promise<WriteResult>;
  async createEntity(
    kind: 'item' | 'property',
    input:
      | Omit<CreateItemInput, 'authorization' | 'authorizationContext'>
      | Omit<CreatePropertyInput, 'authorization' | 'authorizationContext'>,
    options: TaprootWorkshopMutationOptionsV1,
    rawContext: AuthorizationContext,
  ): Promise<WriteResult> {
    const context = await this.#currentContext(rawContext);
    const idempotencyKey = mutationKey(options);
    return this.#idempotent<WriteResult>(
      `create-${kind}`,
      idempotencyKey,
      { input, principalId: context.principalId },
      async () => {
        const authorization = this.#newPolicy(context, {});
        return kind === 'item'
          ? this.#repository.createItem({
              ...(input as CreateItemInput),
              authorization,
              authorizationContext: context,
              requestId: idempotencyKey,
            })
          : this.#repository.createProperty({
              ...(input as CreatePropertyInput),
              authorization,
              authorizationContext: context,
              requestId: idempotencyKey,
            });
      },
    );
  }

  async mutateEntity(
    rawEntityId: EntityId,
    mutations: readonly TaprootWorkshopEntityMutationV1[],
    options: TaprootWorkshopEntityMutationOptionsV1,
    rawContext: AuthorizationContext,
  ): Promise<WriteResult> {
    const entityId = identifier(rawEntityId, 'entityId') as EntityId;
    const context = await this.#currentContext(rawContext);
    const expectedRevision = positiveInteger(
      options?.expectedRevision,
      'expectedRevision',
    );
    const idempotencyKey = mutationKey(options);
    if (
      !Array.isArray(mutations) ||
      mutations.length === 0 ||
      mutations.length > 200
    )
      denied();
    const entries: readonly TaprootWorkshopEntityMutationV1[] = mutations;
    const authoredTexts = entries.map((mutation) =>
      authoredText(mutation.authoredText),
    );
    const commands = entries.map((mutation, index) =>
      commandWithAuthoredText(mutation.command, authoredTexts[index]!),
    );
    return this.#idempotent<WriteResult>(
      'mutate-entity',
      idempotencyKey,
      {
        entityId,
        mutations,
        expectedRevision,
        principalId: context.principalId,
      },
      async () => {
        const authorization = await this.#preservedEntityPolicy(
          entityId,
          commands,
          context,
        );
        return this.#repository.applyCommands(entityId, commands, {
          expectedRevision,
          authorization,
          authorizationContext: context,
          attribution: { id: context.principalId, kind: 'human' },
          editSummary: JSON.stringify(authoredTexts),
          requestId: idempotencyKey,
        });
      },
    );
  }

  async createContent(
    kind: 'resource',
    input: CreateResourceInputV1,
    options: TaprootWorkshopMutationOptionsV1,
    context: AuthorizationContext,
  ): Promise<ResourceV1>;
  async createContent(
    kind: 'annotation',
    input: CreateAnnotationInputV1,
    options: TaprootWorkshopMutationOptionsV1,
    context: AuthorizationContext,
  ): Promise<AnnotationV1>;
  async createContent(
    kind: 'resource' | 'annotation',
    input: CreateResourceInputV1 | CreateAnnotationInputV1,
    options: TaprootWorkshopMutationOptionsV1,
    rawContext: AuthorizationContext,
  ): Promise<ResourceV1 | AnnotationV1> {
    const context = await this.#currentContext(rawContext);
    const idempotencyKey = mutationKey(options);
    return this.#idempotent<ResourceV1 | AnnotationV1>(
      `create-${kind}`,
      idempotencyKey,
      { input, principalId: context.principalId },
      () =>
        kind === 'resource'
          ? this.#content.createResource(
              input as CreateResourceInputV1,
              this.#newContentMetadata(context),
            )
          : this.#content.createAnnotation(
              input as CreateAnnotationInputV1,
              this.#newContentMetadata(context),
            ),
    );
  }

  async updateContent(
    kind: 'resource',
    id: string,
    expectedRevision: number,
    input: CreateResourceInputV1,
    options: TaprootWorkshopMutationOptionsV1,
    context: AuthorizationContext,
  ): Promise<ResourceV1>;
  async updateContent(
    kind: 'annotation',
    id: string,
    expectedRevision: number,
    input: CreateAnnotationInputV1,
    options: TaprootWorkshopMutationOptionsV1,
    context: AuthorizationContext,
  ): Promise<AnnotationV1>;
  async updateContent(
    kind: 'resource' | 'annotation',
    rawId: string,
    rawExpectedRevision: number,
    input: CreateResourceInputV1 | CreateAnnotationInputV1,
    options: TaprootWorkshopMutationOptionsV1,
    rawContext: AuthorizationContext,
  ): Promise<ResourceV1 | AnnotationV1> {
    const id = identifier(rawId, `${kind}Id`);
    const expectedRevision = positiveInteger(
      rawExpectedRevision,
      'expectedRevision',
    );
    const context = await this.#currentContext(rawContext);
    const idempotencyKey = mutationKey(options);
    return this.#idempotent<ResourceV1 | AnnotationV1>(
      `update-${kind}`,
      idempotencyKey,
      { id, expectedRevision, input, principalId: context.principalId },
      async () => {
        const metadata = await this.#preservedContentMetadata(
          kind,
          id,
          context,
        );
        return kind === 'resource'
          ? this.#content.updateResource(id, expectedRevision, input, metadata)
          : this.#content.updateAnnotation(
              id,
              expectedRevision,
              input as CreateAnnotationInputV1,
              metadata,
            );
      },
    );
  }

  async deleteContent(
    kind: 'resource',
    id: string,
    expectedRevision: number,
    options: TaprootWorkshopMutationOptionsV1,
    context: AuthorizationContext,
  ): Promise<ResourceV1>;
  async deleteContent(
    kind: 'annotation',
    id: string,
    expectedRevision: number,
    options: TaprootWorkshopMutationOptionsV1,
    context: AuthorizationContext,
  ): Promise<AnnotationV1>;
  async deleteContent(
    kind: 'resource' | 'annotation',
    rawId: string,
    rawExpectedRevision: number,
    options: TaprootWorkshopMutationOptionsV1,
    rawContext: AuthorizationContext,
  ): Promise<ResourceV1 | AnnotationV1> {
    const id = identifier(rawId, `${kind}Id`);
    const expectedRevision = positiveInteger(
      rawExpectedRevision,
      'expectedRevision',
    );
    const context = await this.#currentContext(rawContext);
    const idempotencyKey = mutationKey(options);
    return this.#idempotent<ResourceV1 | AnnotationV1>(
      `delete-${kind}`,
      idempotencyKey,
      { id, expectedRevision, principalId: context.principalId },
      async () => {
        const metadata = await this.#preservedContentMetadata(
          kind,
          id,
          context,
        );
        return kind === 'resource'
          ? this.#content.deleteResource(id, expectedRevision, metadata)
          : this.#content.deleteAnnotation(id, expectedRevision, metadata);
      },
    );
  }

  async resolveAuthorization(
    raw: TaprootWorkshopPrincipalV1,
  ): Promise<AuthorizationContext> {
    const principalId = identifier(raw?.principalId, 'principalId');
    const activeWorkspaceId =
      raw.activeWorkspaceId === undefined || raw.activeWorkspaceId === null
        ? null
        : identifier(raw.activeWorkspaceId, 'activeWorkspaceId');
    const before = await this.#state();
    const principal = await this.#db
      .prepare(
        `SELECT 1 AS present FROM taproot_authorization_principals
         WHERE installation_id = ? AND principal_id = ?`,
      )
      .bind(this.#installationId, principalId)
      .all<{ present: number }>();
    if (principal.results.length !== 1) denied();
    const grants = await this.#db
      .prepare(
        `SELECT workspace_id, capability
         FROM taproot_authorization_grants
         WHERE installation_id = ? AND principal_id = ?
           AND authorization_revision <= ?
         ORDER BY workspace_id, capability`,
      )
      .bind(this.#installationId, principalId, before)
      .all<{ workspace_id: string; capability: string }>();
    const workspaceIds = [
      ...new Set(grants.results.map((row) => row.workspace_id)),
    ];
    if (activeWorkspaceId !== null && !workspaceIds.includes(activeWorkspaceId))
      denied();
    const capabilities = [
      ...new Set(
        grants.results
          .filter(
            (row) =>
              activeWorkspaceId === null ||
              row.workspace_id === activeWorkspaceId,
          )
          .map((row) => row.capability),
      ),
    ].sort();
    if ((await this.#state()) !== before) denied();
    return normalizeAuthorizationContext({
      installationId: this.#installationId,
      principalId,
      activeWorkspaceId,
      workspaceIds,
      capabilities,
      authorizationRevision: before,
    });
  }

  async statementHistory(
    rawStatementId: string,
    options: TaprootWorkshopHistoryOptionsV1,
    rawContext: AuthorizationContext,
  ): Promise<Page<TaprootWorkshopStatementRevisionV1>> {
    const statementId = identifier(rawStatementId, 'statementId');
    const context = await this.#currentContext(rawContext);
    const entityId = await this.#statementEntity(statementId, context);
    const limit = pageLimit(options?.limit);
    let before = Number.MAX_SAFE_INTEGER;
    if (options?.cursor)
      before = await this.#decodeCursor(
        options.cursor,
        'statement',
        statementId,
        context.authorizationRevision,
      );
    const rows = await this.#db
      .prepare(
        `SELECT source_revision FROM taproot_statement_authorization_revisions
         WHERE entity_id = ? AND statement_id = ? AND source_revision < ?
         ORDER BY source_revision DESC LIMIT ?`,
      )
      .bind(entityId, statementId, before, limit + 1)
      .all<{ source_revision: number }>();
    const items: TaprootWorkshopStatementRevisionV1[] = [];
    for (const row of rows.results.slice(0, limit))
      items.push(
        await this.statementRevision(
          statementId,
          Number(row.source_revision),
          context,
        ),
      );
    await this.#currentContext(context);
    return {
      items,
      cursor:
        rows.results.length > limit && items.length
          ? await this.#encodeCursor(
              'statement',
              statementId,
              context.authorizationRevision,
              items.at(-1)!.entityRevision,
            )
          : null,
    };
  }

  async statementRevision(
    rawStatementId: string,
    rawRevision: number,
    rawContext: AuthorizationContext,
  ): Promise<TaprootWorkshopStatementRevisionV1> {
    const statementId = identifier(rawStatementId, 'statementId');
    const revision = positiveInteger(rawRevision, 'revision');
    const context = await this.#currentContext(rawContext);
    const entityId = await this.#statementEntity(statementId, context);
    await this.#assertStatementVisible(
      entityId,
      statementId,
      revision,
      context,
    );
    const reader = createAuthorizedTaproot(this.#db, this.#options, context, {
      cursorCodec: this.#cursorCodec,
    });
    const entry = await reader
      .getEntityRevision(entityId, revision)
      .catch(() => denied());
    const statement = findStatement(entry, statementId);
    if (!statement) denied();
    await this.#assertStatementVisible(
      entityId,
      statementId,
      revision,
      context,
    );
    return {
      version: 1,
      entityId,
      entityRevision: revision,
      statement,
      revision: entry,
    };
  }

  async contentHistory(
    kind: 'resource',
    id: string,
    options: TaprootWorkshopHistoryOptionsV1,
    context: AuthorizationContext,
  ): Promise<Page<ResourceV1>>;
  async contentHistory(
    kind: 'annotation',
    id: string,
    options: TaprootWorkshopHistoryOptionsV1,
    context: AuthorizationContext,
  ): Promise<Page<AnnotationV1>>;
  async contentHistory(
    kind: 'resource' | 'annotation',
    rawId: string,
    options: TaprootWorkshopHistoryOptionsV1,
    rawContext: AuthorizationContext,
  ): Promise<Page<ResourceV1 | AnnotationV1>> {
    const id = identifier(rawId, `${kind}Id`);
    const context = await this.#currentContext(rawContext);
    const limit = pageLimit(options?.limit);
    let before = Number.MAX_SAFE_INTEGER;
    if (options?.cursor)
      before = await this.#decodeCursor(
        options.cursor,
        kind,
        id,
        context.authorizationRevision,
      );
    await this.#assertContentVisible(kind, id, null, context);
    const rows = await this.#db
      .prepare(
        `SELECT revision FROM taproot_content_revisions
         WHERE record_kind = ? AND record_id = ? AND revision < ?
         ORDER BY revision DESC LIMIT ?`,
      )
      .bind(kind, id, before, limit + 1)
      .all<{ revision: number }>();
    const items: (ResourceV1 | AnnotationV1)[] = [];
    for (const row of rows.results.slice(0, limit))
      items.push(
        await this.contentRevision(
          kind as 'resource',
          id,
          Number(row.revision),
          context,
        ),
      );
    await this.#currentContext(context);
    return {
      items,
      cursor:
        rows.results.length > limit && items.length
          ? await this.#encodeCursor(
              kind,
              id,
              context.authorizationRevision,
              items.at(-1)!.revision,
            )
          : null,
    };
  }

  async contentRevision(
    kind: 'resource',
    id: string,
    revision: number,
    context: AuthorizationContext,
  ): Promise<ResourceV1>;
  async contentRevision(
    kind: 'annotation',
    id: string,
    revision: number,
    context: AuthorizationContext,
  ): Promise<AnnotationV1>;
  async contentRevision(
    kind: 'resource' | 'annotation',
    rawId: string,
    rawRevision: number,
    rawContext: AuthorizationContext,
  ): Promise<ResourceV1 | AnnotationV1> {
    const id = identifier(rawId, `${kind}Id`);
    const revision = positiveInteger(rawRevision, 'revision');
    const context = await this.#currentContext(rawContext);
    await this.#assertContentVisible(kind, id, revision, context);
    const record =
      kind === 'resource'
        ? await this.#content
            .getResourceRevision(id, revision, context)
            .catch(() => denied())
        : await this.#content
            .getAnnotationRevision(id, revision, context)
            .catch(() => denied());
    await this.#assertContentVisible(kind, id, revision, context);
    return record;
  }

  async hydrateResource(
    rawId: string,
    rawRevision: number,
    rawContext: AuthorizationContext,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const id = identifier(rawId, 'resourceId');
    const revision = positiveInteger(rawRevision, 'revision');
    const context = await this.#currentContext(rawContext);
    const resource = await this.contentRevision(
      'resource',
      id,
      revision,
      context,
    );
    if (resource.integrity.byteLength > this.#maxHydratedResourceBytes)
      denied();
    const bytes = await this.#content
      .hydrateResourceRevisionPayload(id, revision, context, signal)
      .catch((error: unknown) => {
        if (signal?.aborted) throw signal.reason ?? error;
        denied();
      });
    if (
      bytes.byteLength !== resource.integrity.byteLength ||
      bytes.byteLength > this.#maxHydratedResourceBytes ||
      (await sha256Hex(bytes)) !== resource.integrity.digest
    )
      denied();
    await this.#currentContext(context);
    return bytes;
  }

  async #statementEntity(
    statementId: string,
    context: AuthorizationContext,
  ): Promise<EntityId> {
    const row = await this.#db
      .prepare(
        `SELECT entity_id FROM taproot_statement_authorization_revisions
         WHERE statement_id = ? ORDER BY source_revision DESC LIMIT 1`,
      )
      .bind(statementId)
      .all<{ entity_id: EntityId }>();
    const entityId = row.results[0]?.entity_id;
    if (!entityId) denied();
    const reader = createAuthorizedTaproot(this.#db, this.#options, context, {
      cursorCodec: this.#cursorCodec,
    });
    await reader.getEntity(entityId).catch(() => denied());
    return entityId;
  }

  async #assertStatementVisible(
    entityId: EntityId,
    statementId: string,
    revision: number,
    context: AuthorizationContext,
  ): Promise<void> {
    await this.#currentContext(context);
    const result = await this.#db
      .prepare(
        `SELECT current.effective_visibility_json AS current_visibility_json,
                history.effective_visibility_json AS history_visibility_json
         FROM taproot_entity_authorization current
         JOIN taproot_statement_authorization_revisions history
           ON history.entity_id = current.entity_id
         WHERE current.entity_id = ? AND history.statement_id = ?
           AND history.source_revision = ?
           AND current.installation_id = ?`,
      )
      .bind(entityId, statementId, revision, this.#installationId)
      .all<{
        current_visibility_json: string;
        history_visibility_json: string;
      }>();
    const row = result.results[0];
    if (
      !row ||
      !visible(row.current_visibility_json, context) ||
      !visible(row.history_visibility_json, context)
    )
      denied();
  }

  async #assertContentVisible(
    kind: 'resource' | 'annotation',
    id: string,
    revision: number | null,
    context: AuthorizationContext,
  ): Promise<void> {
    await this.#currentContext(context);
    const table =
      kind === 'resource' ? 'taproot_resources' : 'taproot_annotations';
    const current = await this.#db
      .prepare(
        `SELECT visibility_json FROM ${table}
         WHERE installation_id = ? AND record_id = ?`,
      )
      .bind(this.#installationId, id)
      .all<{ visibility_json: string }>();
    const row = current.results[0];
    if (!row || !visible(row.visibility_json, context)) denied();
    if (revision !== null) {
      const historical = await this.#db
        .prepare(
          `SELECT visibility_json
           FROM taproot_content_authorization_revisions
           WHERE record_kind = ? AND record_id = ? AND revision = ?
             AND installation_id = ?`,
        )
        .bind(kind, id, revision, this.#installationId)
        .all<{ visibility_json: string }>();
      if (
        !historical.results[0] ||
        !visible(historical.results[0].visibility_json, context)
      )
        denied();
    }
  }

  async #currentContext(
    raw: AuthorizationContext,
  ): Promise<AuthorizationContext> {
    let context: AuthorizationContext;
    try {
      context = normalizeAuthorizationContext(raw);
    } catch {
      denied();
    }
    if (
      context.installationId !== this.#installationId ||
      context.authorizationRevision !== (await this.#state())
    )
      denied();
    return context;
  }

  #newPolicy(
    context: AuthorizationContext,
    statementRestrictions: Readonly<
      Record<string, readonly VisibilityScopeV1[]>
    >,
  ) {
    const workspaceId = context.activeWorkspaceId;
    return {
      installationId: this.#installationId,
      workspaceId,
      ownerPrincipalId: context.principalId,
      visibility:
        workspaceId === null
          ? {
              version: 1 as const,
              clauses: [
                [
                  {
                    kind: 'principal' as const,
                    principalId: context.principalId,
                  },
                ],
              ],
            }
          : {
              version: 1 as const,
              clauses: [[{ kind: 'workspace' as const, workspaceId }]],
            },
      statementRestrictions,
      expectedAuthorizationRevision: context.authorizationRevision,
    };
  }

  async #preservedEntityPolicy(
    entityId: EntityId,
    commands: readonly EntityCommand[],
    context: AuthorizationContext,
  ) {
    const current = await this.#db
      .prepare(
        `SELECT workspace_id, owner_principal_id, visibility_json
         FROM taproot_entity_authorization
         WHERE entity_id = ? AND installation_id = ?`,
      )
      .bind(entityId, this.#installationId)
      .all<{
        workspace_id: string | null;
        owner_principal_id: string;
        visibility_json: string;
      }>();
    const row = current.results[0];
    if (!row || !visible(row.visibility_json, context)) denied();
    const restrictions = await this.#db
      .prepare(
        `SELECT statement_id, restrictions_json
         FROM taproot_statement_authorization
         WHERE entity_id = ? ORDER BY statement_id`,
      )
      .bind(entityId)
      .all<{ statement_id: string; restrictions_json: string }>();
    const byStatement = Object.fromEntries(
      restrictions.results.map((entry) => [
        entry.statement_id,
        JSON.parse(entry.restrictions_json) as readonly VisibilityScopeV1[],
      ]),
    );
    for (const command of commands) {
      if (command.type === 'add-statement')
        byStatement[command.statement.id] = [];
      else if (command.type === 'remove-statement')
        delete byStatement[command.statementId];
      else if (
        command.type === 'replace-statement' &&
        command.statement.id !== command.statementId
      ) {
        const prior = byStatement[command.statementId] ?? [];
        delete byStatement[command.statementId];
        byStatement[command.statement.id] = prior;
      }
    }
    return {
      installationId: this.#installationId,
      workspaceId: row.workspace_id,
      ownerPrincipalId: row.owner_principal_id,
      visibility: JSON.parse(row.visibility_json) as VisibilityScopeV1,
      statementRestrictions: byStatement,
      expectedAuthorizationRevision: context.authorizationRevision,
    };
  }

  #newContentMetadata(context: AuthorizationContext) {
    const policy = this.#newPolicy(context, {});
    return {
      context,
      attribution: { id: context.principalId, kind: 'human' as const },
      workspaceId: policy.workspaceId,
      ownerPrincipalId: policy.ownerPrincipalId,
      visibility: policy.visibility,
      expectedAuthorizationRevision: context.authorizationRevision,
    };
  }

  async #preservedContentMetadata(
    kind: 'resource' | 'annotation',
    id: string,
    context: AuthorizationContext,
  ) {
    const record =
      kind === 'resource'
        ? await this.#content.getResource(id, context).catch(() => denied())
        : await this.#content.getAnnotation(id, context).catch(() => denied());
    return {
      context,
      attribution: { id: context.principalId, kind: 'human' as const },
      workspaceId: record.authorization.workspaceId,
      ownerPrincipalId: record.authorization.ownerPrincipalId,
      visibility: record.authorization.visibility,
      expectedAuthorizationRevision: context.authorizationRevision,
    };
  }

  async #idempotent<T>(
    operation: string,
    idempotencyKey: string,
    request: unknown,
    execute: () => Promise<T>,
  ): Promise<T> {
    const prior = this.#mutationLocks.get(idempotencyKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.then(() => current);
    this.#mutationLocks.set(idempotencyKey, queued);
    await prior;
    try {
      const requestHash = await canonicalSearchHashV1(request);
      const existing = await this.#db
        .prepare(
          `SELECT operation, request_hash, receipt_json
           FROM taproot_workshop_idempotency
           WHERE installation_id = ? AND idempotency_key = ?`,
        )
        .bind(this.#installationId, idempotencyKey)
        .all<{
          operation: string;
          request_hash: string;
          receipt_json: string;
        }>();
      const row = existing.results[0];
      if (row) {
        if (row.operation !== operation || row.request_hash !== requestHash)
          denied();
        return JSON.parse(row.receipt_json) as T;
      }
      const receipt = await execute();
      await this.#db
        .prepare(
          `INSERT INTO taproot_workshop_idempotency(
             installation_id, idempotency_key, operation, request_hash,
             receipt_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          this.#installationId,
          idempotencyKey,
          operation,
          requestHash,
          JSON.stringify(receipt),
          new Date().toISOString(),
        )
        .run();
      return receipt;
    } finally {
      release();
      if (this.#mutationLocks.get(idempotencyKey) === queued)
        this.#mutationLocks.delete(idempotencyKey);
    }
  }

  async #state(): Promise<number> {
    const result = await this.#db
      .prepare(
        `SELECT authorization_revision FROM taproot_installation_authorization
         WHERE singleton = 1 AND installation_id = ?`,
      )
      .bind(this.#installationId)
      .all<{ authorization_revision: number }>();
    const revision = Number(result.results[0]?.authorization_revision);
    if (!Number.isSafeInteger(revision) || revision < 1) denied();
    return revision;
  }

  async #encodeCursor(
    kind: string,
    id: string,
    authorizationRevision: number,
    before: number,
  ): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(
      JSON.stringify({
        version: 1,
        kind,
        id,
        installationId: this.#installationId,
        authorizationRevision,
        before,
      }),
    );
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.#cursorKey,
      plaintext,
    );
    return `${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
  }

  async #decodeCursor(
    cursor: string,
    kind: string,
    id: string,
    authorizationRevision: number,
  ): Promise<number> {
    try {
      const [rawIv, rawCiphertext, extra] = cursor.split('.');
      if (!rawIv || !rawCiphertext || extra !== undefined)
        throw new Error('invalid');
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64url(rawIv) },
        this.#cursorKey,
        fromBase64url(rawCiphertext),
      );
      const value = JSON.parse(decoder.decode(plaintext)) as Record<
        string,
        unknown
      >;
      if (
        value.version !== 1 ||
        value.kind !== kind ||
        value.id !== id ||
        value.installationId !== this.#installationId ||
        value.authorizationRevision !== authorizationRevision
      )
        throw new Error('invalid');
      return positiveInteger(value.before, 'cursor.before');
    } catch {
      throw new InvalidCursorError('Cursor is invalid');
    }
  }
}

function findStatement(
  entry: RevisionEntry,
  statementId: string,
): Statement | null {
  if (entry.entity.type !== 'item') return null;
  for (const statements of Object.values(entry.entity.claims))
    for (const statement of statements)
      if (statement.id === statementId) return statement;
  return null;
}

function commandWithAuthoredText(
  command: EntityCommand,
  text: string,
): EntityCommand {
  if (!command || typeof command !== 'object') denied();
  switch (command.type) {
    case 'add-statement':
    case 'replace-statement':
      return {
        ...structuredClone(command),
        statement: { ...structuredClone(command.statement), text },
      };
    case 'set-statement-rank':
    case 'add-qualifier':
    case 'remove-qualifier':
    case 'add-reference':
    case 'replace-reference':
    case 'remove-reference':
      return { ...structuredClone(command), text };
    default:
      return structuredClone(command);
  }
}

function authoredText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    encoder.encode(value).byteLength > 65_536
  )
    throw new TypeError('authoredText is invalid');
  return value;
}

function visible(raw: string, context: AuthorizationContext): boolean {
  try {
    return isVisibleTo(JSON.parse(raw) as VisibilityScopeV1, context);
  } catch {
    return false;
  }
}

function pageLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const limit = positiveInteger(value, 'limit');
  if (limit > MAX_LIMIT) denied();
  return limit;
}

function mutationKey(options: TaprootWorkshopMutationOptionsV1): string {
  return identifier(options?.idempotencyKey, 'idempotencyKey');
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new TypeError(`${field} is invalid`);
  return Number(value);
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new TypeError(`${field} is invalid`);
  return value;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replace(/-/gu, '+')
    .replace(/_/gu, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function denied(): never {
  throw new AuthorizationDeniedError('Authorization denied');
}
