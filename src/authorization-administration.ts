import type {
  D1DatabaseLike,
  SqlitePreparedStatementLike,
} from './sqlite-types.js';
import type { TaprootHostWriteCapability } from './assembly-authority.js';
import { assertTaprootHostWriteCapabilityInternal } from './assembly-authority.js';
import {
  normalizeAuthorizationContext,
  normalizeVisibilityScope,
  KNOWLEDGE_POLICY_CAPABILITY,
  KNOWLEDGE_WRITE_CAPABILITY,
  SEARCH_ADMIN_CAPABILITY,
} from './authorization.js';
import { AuthorizationDeniedError, RevisionConflictError } from './errors.js';
import { canonicalSearchHashV1 } from './search-contract.js';
import {
  authorizationVisibilityAdministrationV1,
  coordinatedStatementsV1,
} from './atomic-coordination.js';
import { TaprootRepository } from './repository.js';
import { TaprootContentRepositoryV1 } from './content-domain.js';
import type {
  Attribution,
  AuthorizationContext,
  EntityId,
  TaprootOptions,
  StatementRevisionEdit,
  VisibilityScopeV1,
  WikibaseEntity,
} from './types.js';

export type AuthorizationAdministrationCommandV1 =
  | { type: 'put-principal'; principalId: string }
  | { type: 'put-workspace'; workspaceId: string }
  | {
      type: 'put-grant';
      principalId: string;
      workspaceId: string;
      capability: string;
      granted: boolean;
    }
  | {
      type: 'set-entity-visibility';
      entityId: string;
      expectedRevision: number;
      visibility: VisibilityScopeV1;
    }
  | {
      type: 'set-resource-visibility';
      resourceId: string;
      expectedRevision: number;
      visibility: VisibilityScopeV1;
    }
  | {
      type: 'set-annotation-visibility';
      annotationId: string;
      expectedRevision: number;
      visibility: VisibilityScopeV1;
    };

export interface AuthorizationAdministrationInputV1 {
  installationId: string;
  expectedAuthorizationRevision: number;
  idempotencyKey: string;
  command: AuthorizationAdministrationCommandV1;
}

export interface AuthorizationAdministrationParticipantV1 {
  readonly kind: 'taproot-authorization-administration-participant-v1';
  readonly installationId: string;
  readonly connectionId: string;
}

export interface AuthorizationAdministrationOwnerParticipantV1 {
  readonly kind: 'taproot-authorization-administration-owner-participant-v1';
  readonly ownerRegistrationId: string;
}

export interface AuthorizationAdministrationReceiptV1 {
  format: 'taproot-authorization-administration-receipt-v1';
  administrationId: string;
  installationId: string;
  command: AuthorizationAdministrationCommandV1['type'];
  authorizationRevision: number;
  searchGeneration: number;
  ownerReceiptSha256: string;
  replayed: boolean;
}

export interface AuthorizationAdministrationOwnerAdapterV1 {
  readonly kind: 'taproot-authorization-administration-owner-adapter-v1';
  prepare(ownerToken: unknown): Promise<{
    statements: readonly unknown[];
    receipt: unknown;
  }>;
}

export interface AuthorizationAdministrationOwnerIssuerV1 {
  readonly ownerRegistrationId: string;
  seal(
    participant: AuthorizationAdministrationParticipantV1,
    ownerToken: unknown,
  ): Promise<AuthorizationAdministrationOwnerParticipantV1>;
}

interface AdministrationBinding {
  db: D1DatabaseLike;
  options: TaprootOptions;
  context: AuthorizationContext;
  input: Readonly<AuthorizationAdministrationInputV1>;
  digest: string;
  administrationId: string;
  connectionId: string;
  replay: AuthorizationAdministrationReceiptV1 | null;
  status: 'fresh' | 'committing' | 'committed' | 'failed';
}

interface OwnerBinding {
  db: D1DatabaseLike;
  installationId: string;
  ownerRegistrationId: string;
  adapter: AuthorizationAdministrationOwnerAdapterV1;
}

interface OwnerParticipantBinding {
  owner: OwnerBinding;
  administration: AdministrationBinding;
  token: unknown;
  status: 'fresh' | 'consumed' | 'failed';
}

const administrationBindings = new WeakMap<object, AdministrationBinding>();
const ownerParticipantBindings = new WeakMap<object, OwnerParticipantBinding>();
const connectionIds = new WeakMap<object, string>();

export function registerAuthorizationAdministrationOwnerV1(
  db: D1DatabaseLike,
  options: TaprootOptions,
  authority: TaprootHostWriteCapability,
  input: {
    installationId: string;
    ownerRegistrationId: string;
    adapter: AuthorizationAdministrationOwnerAdapterV1;
  },
): Promise<AuthorizationAdministrationOwnerIssuerV1> {
  assertTaprootHostWriteCapabilityInternal(db, options, authority);
  const owner: OwnerBinding = {
    db,
    installationId: identifier(input.installationId, 'installationId'),
    ownerRegistrationId: identifier(
      input.ownerRegistrationId,
      'ownerRegistrationId',
    ),
    adapter: input.adapter,
  };
  if (
    owner.adapter?.kind !==
      'taproot-authorization-administration-owner-adapter-v1' ||
    typeof owner.adapter.prepare !== 'function'
  )
    denied('authorization administration owner adapter is invalid');
  return Promise.resolve(
    Object.freeze({
      ownerRegistrationId: owner.ownerRegistrationId,
      seal: (
        participant: AuthorizationAdministrationParticipantV1,
        ownerToken: unknown,
      ) => sealOwner(owner, participant, ownerToken),
    }),
  );
}

export async function prepareAuthorizationAdministrationV1(
  db: D1DatabaseLike,
  options: TaprootOptions,
  authority: TaprootHostWriteCapability,
  raw: AuthorizationAdministrationInputV1,
  rawContext: AuthorizationContext,
): Promise<AuthorizationAdministrationParticipantV1> {
  assertTaprootHostWriteCapabilityInternal(db, options, authority);
  const context = normalizeAuthorizationContext(rawContext);
  const input = normalizeInput(raw);
  if (
    context.installationId !== input.installationId ||
    !context.capabilities.includes(SEARCH_ADMIN_CAPABILITY)
  )
    denied('live search administrator capability is required');
  const digest = await canonicalSearchHashV1(input);
  const replay = await readReplay(
    db,
    input.installationId,
    input.idempotencyKey,
  );
  if (replay && replay.request_sha256 !== digest)
    throw new RevisionConflictError(
      'Authorization administration idempotency key conflicts',
    );
  await requireLiveAdministrator(db, context);
  if (
    !replay &&
    context.authorizationRevision !== input.expectedAuthorizationRevision
  )
    denied('authorization administration context is stale');
  const state = await installationState(db, input.installationId);
  if (
    !replay &&
    state.authorization_revision !== input.expectedAuthorizationRevision
  )
    throw new RevisionConflictError(
      'Authorization administration expected revision is stale',
    );
  const connectionId = connectionIdentity(db);
  const administrationId = `authorization-administration-${digest}`;
  const participant: AuthorizationAdministrationParticipantV1 = Object.freeze({
    kind: 'taproot-authorization-administration-participant-v1',
    installationId: input.installationId,
    connectionId,
  });
  administrationBindings.set(participant, {
    db,
    options,
    context,
    input,
    digest,
    administrationId,
    connectionId,
    replay: replay ? receiptFromRow(replay, true) : null,
    status: 'fresh',
  });
  return participant;
}

export async function commitAuthorizationAdministrationV1(
  participant: AuthorizationAdministrationParticipantV1,
  ownerParticipant: AuthorizationAdministrationOwnerParticipantV1,
): Promise<AuthorizationAdministrationReceiptV1> {
  const administration = administrationBindings.get(participant);
  const sealed = ownerParticipantBindings.get(ownerParticipant);
  if (
    !administration ||
    !sealed ||
    sealed.administration !== administration ||
    sealed.owner.db !== administration.db ||
    sealed.owner.installationId !== administration.input.installationId ||
    participant.connectionId !== administration.connectionId ||
    administration.status !== 'fresh' ||
    sealed.status !== 'fresh'
  )
    denied('authorization administration participants are invalid');
  administration.status = 'committing';
  sealed.status = 'consumed';
  if (administration.replay) {
    administration.status = 'committed';
    return administration.replay;
  }
  const prepared = await sealed.owner.adapter.prepare(sealed.token);
  const ownerStatements = normalizeStatements(prepared?.statements);
  const ownerReceiptSha256 = await canonicalSearchHashV1(prepared?.receipt);
  try {
    const receipt = await applyCommand(
      administration,
      sealed.owner.ownerRegistrationId,
      ownerReceiptSha256,
      ownerStatements,
    );
    administration.status = 'committed';
    return receipt;
  } catch (cause) {
    administration.status = 'failed';
    sealed.status = 'failed';
    throw cause;
  }
}

async function applyCommand(
  binding: AdministrationBinding,
  ownerRegistrationId: string,
  ownerReceiptSha256: string,
  ownerStatements: readonly SqlitePreparedStatementLike[],
): Promise<AuthorizationAdministrationReceiptV1> {
  const state = await installationState(
    binding.db,
    binding.input.installationId,
  );
  if (
    state.authorization_revision !== binding.input.expectedAuthorizationRevision
  )
    throw new RevisionConflictError(
      'Authorization administration lost its expected revision',
    );
  const nextRevision = state.authorization_revision + 1;
  const nextGeneration = state.search_generation + 1;
  const receipt: AuthorizationAdministrationReceiptV1 = {
    format: 'taproot-authorization-administration-receipt-v1',
    administrationId: binding.administrationId,
    installationId: binding.input.installationId,
    command: binding.input.command.type,
    authorizationRevision: nextRevision,
    searchGeneration: nextGeneration,
    ownerReceiptSha256,
    replayed: false,
  };
  const coordinated = [
    ...ownerStatements,
    ...administrationLedger(
      binding,
      ownerRegistrationId,
      receipt,
      nextRevision,
      nextGeneration,
    ),
  ];
  const command = binding.input.command;
  if (command.type === 'set-entity-visibility') {
    await applyEntityVisibility(binding, command, coordinated);
  } else if (
    command.type === 'set-resource-visibility' ||
    command.type === 'set-annotation-visibility'
  ) {
    await applyContentVisibility(binding, command, coordinated);
  } else {
    await binding.db.batch([
      ...principalCommandStatements(binding, command, nextRevision),
      ...authorizationAdvance(
        binding,
        nextRevision,
        nextGeneration,
        state.last_advance_id,
      ),
      ...coordinated,
    ]);
  }
  return receipt;
}

async function applyEntityVisibility(
  binding: AdministrationBinding,
  command: Extract<
    AuthorizationAdministrationCommandV1,
    { type: 'set-entity-visibility' }
  >,
  coordinated: readonly SqlitePreparedStatementLike[],
): Promise<void> {
  const repository = new TaprootRepository(binding.db, binding.options);
  const entityId = command.entityId as EntityId;
  const stored = await repository.getEntity(entityId);
  if (stored.entity.lastrevid !== command.expectedRevision)
    throw new RevisionConflictError('Entity authorization revision is stale');
  const policy = await binding.db
    .prepare(
      `SELECT workspace_id, owner_principal_id FROM taproot_entity_authorization
       WHERE entity_id=? AND installation_id=? AND source_revision=?`,
    )
    .bind(entityId, binding.input.installationId, command.expectedRevision)
    .all<{ workspace_id: string | null; owner_principal_id: string }>();
  if (!policy.results[0]) denied('entity authorization policy is unavailable');
  const currentPolicy = policy.results[0];
  const restrictions = await binding.db
    .prepare(
      `SELECT statement_id, restrictions_json
       FROM taproot_statement_authorization WHERE entity_id=?`,
    )
    .bind(entityId)
    .all<{ statement_id: string; restrictions_json: string }>();
  const statementRestrictions = Object.fromEntries(
    restrictions.results.map((row) => [
      row.statement_id,
      JSON.parse(row.restrictions_json) as VisibilityScopeV1[],
    ]),
  );
  const edit: StatementRevisionEdit & {
    [coordinatedStatementsV1]: readonly SqlitePreparedStatementLike[];
    [authorizationVisibilityAdministrationV1]: true;
  } = {
    expectedRevision: command.expectedRevision,
    statementTexts: statementTexts(stored.entity),
    attribution: administratorAttribution(binding.context),
    editSummary: 'authorization visibility administration',
    authorizationContext: {
      ...binding.context,
      capabilities: [
        ...new Set([
          ...binding.context.capabilities,
          KNOWLEDGE_WRITE_CAPABILITY,
          KNOWLEDGE_POLICY_CAPABILITY,
        ]),
      ],
    },
    authorization: {
      installationId: binding.input.installationId,
      workspaceId: currentPolicy.workspace_id,
      ownerPrincipalId: currentPolicy.owner_principal_id,
      visibility: normalizeVisibilityScope(command.visibility),
      statementRestrictions,
      expectedAuthorizationRevision:
        binding.input.expectedAuthorizationRevision,
    },
    [coordinatedStatementsV1]: coordinated,
    [authorizationVisibilityAdministrationV1]: true,
  };
  await repository.replaceEntity(entityId, stored.entity, edit);
}

async function applyContentVisibility(
  binding: AdministrationBinding,
  command: Extract<
    AuthorizationAdministrationCommandV1,
    { type: 'set-resource-visibility' | 'set-annotation-visibility' }
  >,
  coordinated: readonly SqlitePreparedStatementLike[],
): Promise<void> {
  const content = new TaprootContentRepositoryV1(binding.db, {
    installationId: binding.input.installationId,
  });
  const metadata = {
    context: binding.context,
    attribution: administratorAttribution(binding.context),
    workspaceId: binding.context.activeWorkspaceId,
    ownerPrincipalId: binding.context.principalId,
    visibility: normalizeVisibilityScope(command.visibility),
    expectedAuthorizationRevision: binding.input.expectedAuthorizationRevision,
    [coordinatedStatementsV1]: coordinated,
  };
  if (command.type === 'set-resource-visibility') {
    await content.updateResource(
      command.resourceId,
      command.expectedRevision,
      {},
      metadata,
    );
  } else {
    const current = await content.getAnnotation(
      command.annotationId,
      binding.context,
    );
    await content.updateAnnotation(
      command.annotationId,
      command.expectedRevision,
      {
        id: current.id,
        body: current.body,
        target: current.target,
        ...(current.motivation ? { motivation: current.motivation } : {}),
        ...(current.creator ? { creator: current.creator } : {}),
        ...(current.generator ? { generator: current.generator } : {}),
        ...(current.language ? { language: current.language } : {}),
        ...(current.mediaType ? { mediaType: current.mediaType } : {}),
      },
      metadata,
    );
  }
}

function principalCommandStatements(
  binding: AdministrationBinding,
  command: Exclude<
    AuthorizationAdministrationCommandV1,
    {
      type:
        | 'set-entity-visibility'
        | 'set-resource-visibility'
        | 'set-annotation-visibility';
    }
  >,
  nextRevision: number,
): SqlitePreparedStatementLike[] {
  const now = new Date().toISOString();
  if (command.type === 'put-principal')
    return [
      binding.db
        .prepare(
          `INSERT INTO taproot_authorization_principals(
             installation_id, principal_id, created_at
           ) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .bind(binding.input.installationId, command.principalId, now),
    ];
  if (command.type === 'put-workspace')
    return [
      binding.db
        .prepare(
          `INSERT INTO taproot_authorization_workspaces(
             installation_id, workspace_id, created_at
           ) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .bind(binding.input.installationId, command.workspaceId, now),
    ];
  return command.granted
    ? [
        binding.db
          .prepare(
            `INSERT INTO taproot_authorization_grants(
               installation_id, principal_id, workspace_id, capability,
               authorization_revision, created_at
             ) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT DO UPDATE SET
               authorization_revision=excluded.authorization_revision,
               created_at=excluded.created_at`,
          )
          .bind(
            binding.input.installationId,
            command.principalId,
            command.workspaceId,
            command.capability,
            nextRevision,
            now,
          ),
      ]
    : [
        binding.db
          .prepare(
            `DELETE FROM taproot_authorization_grants
             WHERE installation_id=? AND principal_id=? AND workspace_id=?
               AND capability=?`,
          )
          .bind(
            binding.input.installationId,
            command.principalId,
            command.workspaceId,
            command.capability,
          ),
      ];
}

function authorizationAdvance(
  binding: AdministrationBinding,
  nextRevision: number,
  nextGeneration: number,
  lastAdvanceId: string,
): SqlitePreparedStatementLike[] {
  const now = new Date().toISOString();
  return [
    binding.db
      .prepare(
        `UPDATE taproot_installation_authorization
         SET authorization_revision=?, search_generation=?,
             last_advance_id=?, updated_at=?
         WHERE installation_id=? AND authorization_revision=?
           AND search_generation=? AND last_advance_id=?`,
      )
      .bind(
        nextRevision,
        nextGeneration,
        binding.administrationId,
        now,
        binding.input.installationId,
        binding.input.expectedAuthorizationRevision,
        nextGeneration - 1,
        lastAdvanceId,
      ),
    binding.db
      .prepare(
        `INSERT INTO taproot_assertions(assertion_key)
         SELECT NULL WHERE NOT EXISTS(
           SELECT 1 FROM taproot_installation_authorization
           WHERE installation_id=? AND authorization_revision=?
             AND search_generation=? AND last_advance_id=?
         )`,
      )
      .bind(
        binding.input.installationId,
        nextRevision,
        nextGeneration,
        binding.administrationId,
      ),
    binding.db
      .prepare(
        `INSERT INTO taproot_installation_authorization_advances(
           advance_id, installation_id, from_revision, to_revision,
           search_generation, domain, principal_id, reason, created_at
         ) VALUES (?, ?, ?, ?, ?, 'taproot-authorization-administration',
                   ?, ?, ?)`,
      )
      .bind(
        binding.administrationId,
        binding.input.installationId,
        binding.input.expectedAuthorizationRevision,
        nextRevision,
        nextGeneration,
        binding.context.principalId,
        binding.input.command.type,
        now,
      ),
  ];
}

function administrationLedger(
  binding: AdministrationBinding,
  ownerRegistrationId: string,
  receipt: AuthorizationAdministrationReceiptV1,
  nextRevision: number,
  nextGeneration: number,
): SqlitePreparedStatementLike[] {
  const now = new Date().toISOString();
  return [
    binding.db
      .prepare(
        `INSERT INTO taproot_authorization_administrations(
           administration_id, installation_id, idempotency_key,
           request_sha256, command_type, expected_authorization_revision,
           authorization_revision, search_generation, principal_id,
           owner_registration_id, owner_receipt_sha256, receipt_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        binding.administrationId,
        binding.input.installationId,
        binding.input.idempotencyKey,
        binding.digest,
        binding.input.command.type,
        binding.input.expectedAuthorizationRevision,
        nextRevision,
        nextGeneration,
        binding.context.principalId,
        ownerRegistrationId,
        receipt.ownerReceiptSha256,
        JSON.stringify(receipt),
        now,
      ),
  ];
}

function sealOwner(
  owner: OwnerBinding,
  participant: AuthorizationAdministrationParticipantV1,
  token: unknown,
): Promise<AuthorizationAdministrationOwnerParticipantV1> {
  const administration = administrationBindings.get(participant);
  if (
    !administration ||
    administration.db !== owner.db ||
    administration.input.installationId !== owner.installationId ||
    administration.status !== 'fresh'
  )
    denied('authorization administration owner binding is invalid');
  const sealed: AuthorizationAdministrationOwnerParticipantV1 = Object.freeze({
    kind: 'taproot-authorization-administration-owner-participant-v1',
    ownerRegistrationId: owner.ownerRegistrationId,
  });
  ownerParticipantBindings.set(sealed, {
    owner,
    administration,
    token,
    status: 'fresh',
  });
  return Promise.resolve(sealed);
}

async function requireLiveAdministrator(
  db: D1DatabaseLike,
  context: AuthorizationContext,
): Promise<void> {
  const result = await db
    .prepare(
      `SELECT 1 AS present FROM taproot_authorization_principals p
       WHERE p.installation_id=? AND p.principal_id=? AND EXISTS(
         SELECT 1 FROM taproot_authorization_grants g
         WHERE g.installation_id=p.installation_id
           AND g.principal_id=p.principal_id
           AND g.capability=?
       )`,
    )
    .bind(context.installationId, context.principalId, SEARCH_ADMIN_CAPABILITY)
    .all<{ present: number }>();
  if (!result.results[0])
    denied('live search administrator capability is required');
}

async function installationState(db: D1DatabaseLike, installationId: string) {
  const result = await db
    .prepare(
      `SELECT authorization_revision, search_generation, last_advance_id
       FROM taproot_installation_authorization WHERE installation_id=?`,
    )
    .bind(installationId)
    .all<{
      authorization_revision: number;
      search_generation: number;
      last_advance_id: string;
    }>();
  if (!result.results[0]) denied('installation authorization is unavailable');
  const row = result.results[0];
  return {
    authorization_revision: Number(row.authorization_revision),
    search_generation: Number(row.search_generation),
    last_advance_id: row.last_advance_id,
  };
}

type AdministrationRow = {
  request_sha256: string;
  receipt_json: string;
};

async function readReplay(
  db: D1DatabaseLike,
  installationId: string,
  idempotencyKey: string,
): Promise<AdministrationRow | null> {
  const result = await db
    .prepare(
      `SELECT request_sha256, receipt_json
       FROM taproot_authorization_administrations
       WHERE installation_id=? AND idempotency_key=?`,
    )
    .bind(installationId, idempotencyKey)
    .all<AdministrationRow>();
  return result.results[0] ?? null;
}

function receiptFromRow(
  row: AdministrationRow,
  replayed: boolean,
): AuthorizationAdministrationReceiptV1 {
  return {
    ...(JSON.parse(row.receipt_json) as AuthorizationAdministrationReceiptV1),
    replayed,
  };
}

function normalizeInput(
  raw: AuthorizationAdministrationInputV1,
): Readonly<AuthorizationAdministrationInputV1> {
  const command = structuredClone(raw.command);
  if ('principalId' in command)
    command.principalId = identifier(command.principalId, 'principalId');
  if ('workspaceId' in command)
    command.workspaceId = identifier(command.workspaceId, 'workspaceId');
  if ('capability' in command)
    command.capability = identifier(command.capability, 'capability');
  if ('entityId' in command)
    command.entityId = identifier(command.entityId, 'entityId');
  if ('resourceId' in command)
    command.resourceId = identifier(command.resourceId, 'resourceId');
  if ('annotationId' in command)
    command.annotationId = identifier(command.annotationId, 'annotationId');
  if ('visibility' in command)
    command.visibility = normalizeVisibilityScope(command.visibility);
  if (
    'expectedRevision' in command &&
    (!Number.isInteger(command.expectedRevision) ||
      command.expectedRevision < 1)
  )
    throw new TypeError('expectedRevision is invalid');
  return Object.freeze({
    installationId: identifier(raw.installationId, 'installationId'),
    expectedAuthorizationRevision: positiveRevision(
      raw.expectedAuthorizationRevision,
    ),
    idempotencyKey: identifier(raw.idempotencyKey, 'idempotencyKey'),
    command: Object.freeze(command),
  });
}

function statementTexts(entity: WikibaseEntity): Record<string, string> {
  const result: Record<string, string> = {};
  for (const statements of Object.values(entity.claims))
    for (const statement of statements) result[statement.id] = statement.text;
  return result;
}

function administratorAttribution(context: AuthorizationContext): Attribution {
  return {
    id: context.principalId,
    kind: 'human',
    tool: 'taproot-authorization-administration-v1',
  };
}

function normalizeStatements(
  values: readonly unknown[] | undefined,
): SqlitePreparedStatementLike[] {
  if (!Array.isArray(values)) denied('owner statements are invalid');
  return values.map((value) => {
    if (
      !value ||
      typeof value !== 'object' ||
      typeof (value as SqlitePreparedStatementLike).run !== 'function'
    )
      denied('owner statement is invalid');
    return value as SqlitePreparedStatementLike;
  });
}

function connectionIdentity(db: object): string {
  let id = connectionIds.get(db);
  if (!id) {
    id = crypto.randomUUID();
    connectionIds.set(db, id);
  }
  return id;
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256)
    throw new TypeError(`${name} is invalid`);
  return value;
}

function positiveRevision(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1)
    throw new TypeError('expectedAuthorizationRevision is invalid');
  return Number(value);
}

function denied(message: string): never {
  throw new AuthorizationDeniedError(message);
}
