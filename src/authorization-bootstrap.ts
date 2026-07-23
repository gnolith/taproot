import type {
  D1DatabaseLike,
  SqlitePreparedStatementLike,
} from './sqlite-types.js';
import type { TaprootHostWriteCapability } from './assembly-authority.js';
import { assertTaprootHostWriteCapabilityInternal } from './assembly-authority.js';
import { InvalidAuthorizationError } from './errors.js';
import { canonicalSearchHashV1 } from './search-contract.js';

export interface AuthorizationBootstrapInputV1 {
  installationId: string;
  baseIri: string;
  principalId: string;
  workspaceId: string;
  grants: readonly string[];
  idempotencyKey: string;
}

export interface AuthorizationBootstrapParticipantV1 {
  readonly kind: 'taproot-authorization-bootstrap-participant-v1';
  readonly installationId: string;
  readonly connectionId: string;
}

export interface AuthorizationBootstrapOwnerParticipantV1 {
  readonly kind: 'taproot-authorization-bootstrap-owner-participant-v1';
  readonly ownerRegistrationId: string;
}

export interface AuthorizationBootstrapReceiptV1 {
  format: 'taproot-authorization-bootstrap-receipt-v1';
  bootstrapId: string;
  installationId: string;
  principalId: string;
  workspaceId: string;
  authorizationRevision: number;
  grantManifestSha256: string;
  ownerReceiptSha256: string;
  replayed: boolean;
}

export interface AuthorizationBootstrapOwnerAdapterV1 {
  readonly kind: 'taproot-authorization-bootstrap-owner-adapter-v1';
  prepare(ownerToken: unknown): Promise<{
    statements: readonly unknown[];
    receipt: unknown;
  }>;
}

export interface AuthorizationBootstrapOwnerIssuerV1 {
  readonly ownerRegistrationId: string;
  seal(
    participant: AuthorizationBootstrapParticipantV1,
    ownerToken: unknown,
  ): Promise<AuthorizationBootstrapOwnerParticipantV1>;
}

interface BootstrapBinding {
  db: D1DatabaseLike;
  input: Readonly<AuthorizationBootstrapInputV1>;
  inputDigest: string;
  bootstrapId: string;
  connectionId: string;
  status: 'fresh' | 'committing' | 'committed' | 'failed';
}

interface OwnerBinding {
  db: D1DatabaseLike;
  installationId: string;
  ownerRegistrationId: string;
  adapter: AuthorizationBootstrapOwnerAdapterV1;
}

interface OwnerParticipantBinding {
  owner: OwnerBinding;
  bootstrap: BootstrapBinding;
  ownerToken: unknown;
  status: 'fresh' | 'consumed' | 'failed';
}

const bootstrapBindings = new WeakMap<object, BootstrapBinding>();
const ownerIssuerBindings = new WeakMap<object, OwnerBinding>();
const ownerParticipantBindings = new WeakMap<object, OwnerParticipantBinding>();
const connectionIds = new WeakMap<object, string>();

export function registerAuthorizationBootstrapOwnerV1(
  db: D1DatabaseLike,
  options: { baseIri: string },
  authority: TaprootHostWriteCapability,
  input: {
    installationId: string;
    ownerRegistrationId: string;
    adapter: AuthorizationBootstrapOwnerAdapterV1;
  },
): Promise<AuthorizationBootstrapOwnerIssuerV1> {
  assertTaprootHostWriteCapabilityInternal(db, options, authority);
  const installationId = identifier(
    input.installationId,
    'installationId',
    128,
  );
  const ownerRegistrationId = identifier(
    input.ownerRegistrationId,
    'ownerRegistrationId',
    128,
  );
  if (
    !input.adapter ||
    input.adapter.kind !== 'taproot-authorization-bootstrap-owner-adapter-v1' ||
    typeof input.adapter.prepare !== 'function'
  )
    denied('authorization bootstrap owner adapter is invalid');
  const owner: OwnerBinding = {
    db,
    installationId,
    ownerRegistrationId,
    adapter: input.adapter,
  };
  const issuer: AuthorizationBootstrapOwnerIssuerV1 = Object.freeze({
    ownerRegistrationId,
    seal: (
      participant: AuthorizationBootstrapParticipantV1,
      ownerToken: unknown,
    ) => sealOwnerParticipant(owner, participant, ownerToken),
  });
  ownerIssuerBindings.set(issuer, owner);
  return Promise.resolve(issuer);
}

export async function prepareAuthorizationBootstrapV1(
  db: D1DatabaseLike,
  options: { baseIri: string },
  authority: TaprootHostWriteCapability,
  raw: AuthorizationBootstrapInputV1,
): Promise<AuthorizationBootstrapParticipantV1> {
  assertTaprootHostWriteCapabilityInternal(db, options, authority);
  const input = normalizeInput(raw);
  if (input.baseIri !== options.baseIri.replace(/\/+$/u, ''))
    denied('authorization bootstrap base IRI does not match the connection');
  const persistedBase = await db
    .prepare(
      `SELECT metadata_value FROM taproot_metadata WHERE metadata_key='base_iri'`,
    )
    .all<{ metadata_value: string }>();
  if (persistedBase.results[0]?.metadata_value !== input.baseIri)
    denied('authorization bootstrap base IRI does not match durable identity');
  const inputDigest = await canonicalSearchHashV1(input);
  const bootstrapId = `bootstrap-${inputDigest}`;
  const existing = await db
    .prepare(
      `SELECT input_sha256 FROM taproot_authorization_bootstraps
       WHERE installation_id = ?`,
    )
    .bind(input.installationId)
    .all<{ input_sha256: string }>();
  if (existing.results[0] && existing.results[0].input_sha256 !== inputDigest)
    denied('conflicting authorization bootstrap already exists');
  if (!existing.results[0]) {
    const partial = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM taproot_installation_authorization) AS installations,
           (SELECT COUNT(*) FROM taproot_authorization_principals) AS principals,
           (SELECT COUNT(*) FROM taproot_authorization_workspaces) AS workspaces,
           (SELECT COUNT(*) FROM taproot_authorization_grants) AS grants`,
      )
      .all<{
        installations: number;
        principals: number;
        workspaces: number;
        grants: number;
      }>();
    const row = partial.results[0];
    if (
      !row ||
      Number(row.installations) !== 0 ||
      Number(row.principals) !== 0 ||
      Number(row.workspaces) !== 0 ||
      Number(row.grants) !== 0
    )
      denied('authorization bootstrap state is partial or preexisting');
  }
  const connectionId = connectionIdentity(db);
  const participant: AuthorizationBootstrapParticipantV1 = Object.freeze({
    kind: 'taproot-authorization-bootstrap-participant-v1' as const,
    installationId: input.installationId,
    connectionId,
  });
  bootstrapBindings.set(participant, {
    db,
    input,
    inputDigest,
    bootstrapId,
    connectionId,
    status: 'fresh',
  });
  return participant;
}

export async function commitAuthorizationBootstrapV1(
  participant: AuthorizationBootstrapParticipantV1,
  ownerParticipant: AuthorizationBootstrapOwnerParticipantV1,
): Promise<AuthorizationBootstrapReceiptV1> {
  const bootstrap = bootstrapBindings.get(participant);
  const owner = ownerParticipantBindings.get(ownerParticipant);
  if (
    !bootstrap ||
    !owner ||
    owner.bootstrap !== bootstrap ||
    owner.owner.db !== bootstrap.db ||
    owner.owner.installationId !== bootstrap.input.installationId ||
    participant.connectionId !== bootstrap.connectionId ||
    bootstrap.status !== 'fresh' ||
    owner.status !== 'fresh'
  )
    denied('authorization bootstrap participants are invalid');
  bootstrap.status = 'committing';
  owner.status = 'consumed';
  const existing = await readReceipt(
    bootstrap.db,
    bootstrap.input.installationId,
  );
  if (existing) {
    if (existing.input_sha256 !== bootstrap.inputDigest) {
      bootstrap.status = 'failed';
      owner.status = 'failed';
      denied('authorization bootstrap replay conflicts with durable state');
    }
    bootstrap.status = 'committed';
    return receiptFromRow(existing, true);
  }
  const prepared = await owner.owner.adapter.prepare(owner.ownerToken);
  const statements = normalizeStatements(prepared?.statements);
  const ownerReceiptSha256 = await canonicalSearchHashV1(prepared?.receipt);
  const grantManifestSha256 = await canonicalSearchHashV1(
    bootstrap.input.grants,
  );
  const now = new Date().toISOString();
  try {
    await bootstrap.db.batch([
      bootstrap.db.prepare(
        `INSERT INTO taproot_assertions(assertion_key)
         SELECT NULL WHERE EXISTS (SELECT 1 FROM taproot_entities)`,
      ),
      bootstrap.db
        .prepare(
          `INSERT INTO taproot_installation_authorization(
             singleton, installation_id, authorization_revision,
             search_generation, last_advance_id, created_at, updated_at
           ) VALUES (1, ?, 1, 1, ?, ?, ?)`,
        )
        .bind(bootstrap.input.installationId, bootstrap.bootstrapId, now, now),
      bootstrap.db
        .prepare(
          `INSERT INTO taproot_authorization_principals(
             installation_id, principal_id, created_at
           ) VALUES (?, ?, ?)`,
        )
        .bind(bootstrap.input.installationId, bootstrap.input.principalId, now),
      bootstrap.db
        .prepare(
          `INSERT INTO taproot_authorization_workspaces(
             installation_id, workspace_id, created_at
           ) VALUES (?, ?, ?)`,
        )
        .bind(bootstrap.input.installationId, bootstrap.input.workspaceId, now),
      ...bootstrap.input.grants.map((grant) =>
        bootstrap.db
          .prepare(
            `INSERT INTO taproot_authorization_grants(
               installation_id, principal_id, workspace_id, capability,
               authorization_revision, created_at
             ) VALUES (?, ?, ?, ?, 1, ?)`,
          )
          .bind(
            bootstrap.input.installationId,
            bootstrap.input.principalId,
            bootstrap.input.workspaceId,
            grant,
            now,
          ),
      ),
      ...statements,
      bootstrap.db
        .prepare(
          `INSERT INTO taproot_authorization_bootstraps(
             bootstrap_id, installation_id, principal_id, workspace_id,
             authorization_revision, input_sha256, grant_manifest_sha256,
             owner_registration_id, owner_receipt_sha256, idempotency_key,
             created_at
           ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          bootstrap.bootstrapId,
          bootstrap.input.installationId,
          bootstrap.input.principalId,
          bootstrap.input.workspaceId,
          bootstrap.inputDigest,
          grantManifestSha256,
          owner.owner.ownerRegistrationId,
          ownerReceiptSha256,
          bootstrap.input.idempotencyKey,
          now,
        ),
    ]);
  } catch (cause) {
    bootstrap.status = 'failed';
    owner.status = 'failed';
    throw cause;
  }
  bootstrap.status = 'committed';
  return {
    format: 'taproot-authorization-bootstrap-receipt-v1',
    bootstrapId: bootstrap.bootstrapId,
    installationId: bootstrap.input.installationId,
    principalId: bootstrap.input.principalId,
    workspaceId: bootstrap.input.workspaceId,
    authorizationRevision: 1,
    grantManifestSha256,
    ownerReceiptSha256,
    replayed: false,
  };
}

function sealOwnerParticipant(
  owner: OwnerBinding,
  participant: AuthorizationBootstrapParticipantV1,
  ownerToken: unknown,
): Promise<AuthorizationBootstrapOwnerParticipantV1> {
  const bootstrap = bootstrapBindings.get(participant);
  if (
    !bootstrap ||
    bootstrap.db !== owner.db ||
    bootstrap.input.installationId !== owner.installationId ||
    bootstrap.status !== 'fresh'
  )
    denied('authorization bootstrap owner binding mismatch');
  const sealed: AuthorizationBootstrapOwnerParticipantV1 = Object.freeze({
    kind: 'taproot-authorization-bootstrap-owner-participant-v1' as const,
    ownerRegistrationId: owner.ownerRegistrationId,
  });
  ownerParticipantBindings.set(sealed, {
    owner,
    bootstrap,
    ownerToken,
    status: 'fresh',
  });
  return Promise.resolve(sealed);
}

function normalizeInput(
  raw: AuthorizationBootstrapInputV1,
): Readonly<AuthorizationBootstrapInputV1> {
  const installationId = identifier(raw.installationId, 'installationId', 128);
  let baseIri: string;
  try {
    const parsed = new URL(raw.baseIri);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      denied('baseIri is invalid');
    baseIri = parsed.href.replace(/\/+$/u, '');
  } catch {
    denied('baseIri is invalid');
  }
  const principalId = identifier(raw.principalId, 'principalId', 128);
  const workspaceId = identifier(raw.workspaceId, 'workspaceId', 128);
  const idempotencyKey = identifier(raw.idempotencyKey, 'idempotencyKey', 128);
  if (
    !Array.isArray(raw.grants) ||
    raw.grants.length === 0 ||
    raw.grants.length > 128
  )
    denied('grants are invalid');
  const grants = raw.grants.map((grant) => identifier(grant, 'grant', 128));
  const normalized = [...new Set(grants)].sort();
  if (
    normalized.length !== grants.length ||
    JSON.stringify(normalized) !== JSON.stringify(grants)
  )
    denied('grants must be sorted and unique');
  return Object.freeze({
    installationId,
    baseIri,
    principalId,
    workspaceId,
    grants: Object.freeze(normalized),
    idempotencyKey,
  });
}

function normalizeStatements(
  values: readonly unknown[],
): SqlitePreparedStatementLike[] {
  if (!Array.isArray(values) || values.length > 100)
    denied('authorization bootstrap owner plan is invalid');
  return values.map((value) => {
    if (
      !value ||
      typeof value !== 'object' ||
      typeof (value as { run?: unknown }).run !== 'function' ||
      typeof (value as { bind?: unknown }).bind !== 'function'
    )
      denied('authorization bootstrap owner plan is invalid');
    return value as SqlitePreparedStatementLike;
  });
}

async function readReceipt(db: D1DatabaseLike, installationId: string) {
  const result = await db
    .prepare(
      `SELECT bootstrap_id, installation_id, principal_id, workspace_id,
              authorization_revision, input_sha256, grant_manifest_sha256,
              owner_receipt_sha256
       FROM taproot_authorization_bootstraps WHERE installation_id = ?`,
    )
    .bind(installationId)
    .all<{
      bootstrap_id: string;
      installation_id: string;
      principal_id: string;
      workspace_id: string;
      authorization_revision: number;
      input_sha256: string;
      grant_manifest_sha256: string;
      owner_receipt_sha256: string;
    }>();
  return result.results[0] ?? null;
}

function receiptFromRow(
  row: NonNullable<Awaited<ReturnType<typeof readReceipt>>>,
  replayed: boolean,
): AuthorizationBootstrapReceiptV1 {
  return {
    format: 'taproot-authorization-bootstrap-receipt-v1',
    bootstrapId: row.bootstrap_id,
    installationId: row.installation_id,
    principalId: row.principal_id,
    workspaceId: row.workspace_id,
    authorizationRevision: Number(row.authorization_revision),
    grantManifestSha256: row.grant_manifest_sha256,
    ownerReceiptSha256: row.owner_receipt_sha256,
    replayed,
  };
}

function connectionIdentity(db: object): string {
  let id = connectionIds.get(db);
  if (!id) {
    id = crypto.randomUUID();
    connectionIds.set(db, id);
  }
  return id;
}

function identifier(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim() ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    denied(`${name} is invalid`);
  return value;
}

function denied(message: string): never {
  throw new InvalidAuthorizationError(message);
}
