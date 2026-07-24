import type { D1DatabaseLike } from './sqlite-types.js';
import { isVisibleTo, normalizeAuthorizationContext } from './authorization.js';
import { InvalidAuthorizationError } from './errors.js';
import { canonicalizeTaprootBaseIri } from './migrations.js';
import type { AuthorizationContext, VisibilityScopeV1 } from './types.js';

export interface ScopedSparqlGraphFilterV1 {
  readonly format: 'taproot-sparql-graph-filter-v1';
  readonly datasetId: string;
  readonly allowedSubjectIris: readonly string[];
}

export interface ScopedSparqlPolicyV1 {
  readonly kind: 'taproot-scoped-sparql-policy-v1';
  readonly datasetId: string;
  readonly filter: ScopedSparqlGraphFilterV1;
}

export interface SparqlCanonicalReferenceV1 {
  kind: 'item' | 'resource' | 'annotation';
  sourceId: string;
  sourceRevision: string;
}

interface PolicyBinding {
  db: D1DatabaseLike;
  installationId: string;
  baseIri: string;
  authorizationRevision: number;
  subjects: ReadonlySet<string>;
}

const policyBindings = new WeakMap<object, PolicyBinding>();

export async function prepareScopedSparqlPolicyV1(
  db: D1DatabaseLike,
  input: { installationId: string; baseIri: string },
  rawContext: AuthorizationContext,
): Promise<ScopedSparqlPolicyV1> {
  const context = normalizeAuthorizationContext(rawContext);
  if (context.installationId !== input.installationId)
    denied('SPARQL policy installation mismatch');
  const baseIri = canonicalizeTaprootBaseIri(input.baseIri);
  const identity = await db
    .prepare(
      `SELECT metadata_value FROM taproot_metadata WHERE metadata_key='base_iri'`,
    )
    .all<{ metadata_value: string }>();
  if (identity.results[0]?.metadata_value !== baseIri)
    denied('SPARQL policy database identity mismatch');
  const fence = await authorizationFence(db, input.installationId);
  if (fence !== context.authorizationRevision)
    denied('SPARQL policy authorization fence is stale');
  const subjects = new Set<string>();
  const entities = await db
    .prepare(
      `SELECT e.entity_id, a.effective_visibility_json
       FROM taproot_entities e
       JOIN taproot_entity_authorization a ON a.entity_id=e.entity_id
       WHERE a.installation_id=? AND e.deleted_at IS NULL
         AND a.deleted_at IS NULL ORDER BY e.entity_id`,
    )
    .bind(input.installationId)
    .all<{ entity_id: string; effective_visibility_json: string }>();
  for (const entity of entities.results) {
    const scope = JSON.parse(
      entity.effective_visibility_json,
    ) as VisibilityScopeV1;
    if (isVisibleTo(scope, context))
      subjects.add(`${baseIri}/entity/${encodeURIComponent(entity.entity_id)}`);
  }
  for (const table of [
    ['taproot_resources', 'resource'],
    ['taproot_annotations', 'annotation'],
  ] as const) {
    const rows = await db
      .prepare(
        `SELECT record_id, visibility_json FROM ${table[0]}
         WHERE installation_id=? AND deleted_at IS NULL ORDER BY record_id`,
      )
      .bind(input.installationId)
      .all<{ record_id: string; visibility_json: string }>();
    for (const row of rows.results)
      if (
        isVisibleTo(
          JSON.parse(row.visibility_json) as VisibilityScopeV1,
          context,
        )
      )
        subjects.add(
          `${baseIri}/${table[1]}/${encodeURIComponent(row.record_id)}`,
        );
  }
  const after = await authorizationFence(db, input.installationId);
  if (after !== fence)
    denied('SPARQL policy authorization changed during preparation');
  const subjectList = Object.freeze([...subjects].sort());
  const datasetId = `sparql-${await hash(
    JSON.stringify([
      input.installationId,
      context.principalId,
      context.activeWorkspaceId,
      context.authorizationRevision,
      subjectList,
    ]),
  )}`;
  const filter: ScopedSparqlGraphFilterV1 = Object.freeze({
    format: 'taproot-sparql-graph-filter-v1' as const,
    datasetId,
    allowedSubjectIris: subjectList,
  });
  const policy: ScopedSparqlPolicyV1 = Object.freeze({
    kind: 'taproot-scoped-sparql-policy-v1' as const,
    datasetId,
    filter,
  });
  policyBindings.set(policy, {
    db,
    installationId: input.installationId,
    baseIri,
    authorizationRevision: fence,
    subjects,
  });
  return policy;
}

export async function hydrateScopedSparqlReferencesV1(
  policy: ScopedSparqlPolicyV1,
  references: readonly SparqlCanonicalReferenceV1[],
  rawContext: AuthorizationContext,
): Promise<readonly unknown[]> {
  const binding = policyBindings.get(policy);
  if (!binding || policy.datasetId !== bindingDatasetId(policy))
    denied('SPARQL policy is invalid');
  const context = normalizeAuthorizationContext(rawContext);
  if (
    context.installationId !== binding.installationId ||
    context.authorizationRevision !== binding.authorizationRevision ||
    (await authorizationFence(binding.db, binding.installationId)) !==
      binding.authorizationRevision
  )
    denied('SPARQL policy authorization fence is stale');
  if (references.length > 1000) denied('SPARQL hydration batch is too large');
  const hydrated: unknown[] = [];
  for (const reference of references) {
    const sourceId = identifier(reference.sourceId, 'sourceId', 256);
    const sourceRevision = identifier(
      reference.sourceRevision,
      'sourceRevision',
      128,
    );
    if (reference.kind === 'item') {
      const rows = await binding.db
        .prepare(
          `SELECT e.entity_json, e.revision, a.effective_visibility_json
           FROM taproot_entities e
           JOIN taproot_entity_authorization a ON a.entity_id=e.entity_id
           WHERE e.entity_id=? AND a.installation_id=?
             AND e.deleted_at IS NULL AND a.deleted_at IS NULL`,
        )
        .bind(sourceId, binding.installationId)
        .all<{
          entity_json: string;
          revision: number;
          effective_visibility_json: string;
        }>();
      const row = rows.results[0];
      if (
        !row ||
        String(row.revision) !== sourceRevision ||
        !isVisibleTo(
          JSON.parse(row.effective_visibility_json) as VisibilityScopeV1,
          context,
        )
      )
        denied('SPARQL result is stale or unauthorized');
      hydrated.push(JSON.parse(row.entity_json));
      continue;
    }
    const table =
      reference.kind === 'resource'
        ? 'taproot_resources'
        : reference.kind === 'annotation'
          ? 'taproot_annotations'
          : denied('SPARQL reference kind is invalid');
    const rows = await binding.db
      .prepare(
        `SELECT record_json, revision, visibility_json FROM ${table}
         WHERE record_id=? AND installation_id=? AND deleted_at IS NULL`,
      )
      .bind(sourceId, binding.installationId)
      .all<{
        record_json: string;
        revision: number;
        visibility_json: string;
      }>();
    const row = rows.results[0];
    if (
      !row ||
      String(row.revision) !== sourceRevision ||
      !isVisibleTo(
        JSON.parse(row.visibility_json) as VisibilityScopeV1,
        context,
      )
    )
      denied('SPARQL result is stale or unauthorized');
    hydrated.push(JSON.parse(row.record_json));
  }
  if (
    (await authorizationFence(binding.db, binding.installationId)) !==
    binding.authorizationRevision
  )
    denied('SPARQL authorization changed during hydration');
  return Object.freeze(hydrated);
}

function bindingDatasetId(policy: ScopedSparqlPolicyV1): string {
  return policy.datasetId;
}

async function authorizationFence(
  db: D1DatabaseLike,
  installationId: string,
): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT authorization_revision
       FROM taproot_installation_authorization WHERE installation_id=?`,
    )
    .bind(installationId)
    .all<{ authorization_revision: number }>();
  const revision = Number(rows.results[0]?.authorization_revision);
  if (!Number.isSafeInteger(revision) || revision < 1)
    denied('SPARQL authorization state is unavailable');
  return revision;
}

async function hash(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function identifier(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    denied(`${field} is invalid`);
  return value;
}

function denied(message: string): never {
  throw new InvalidAuthorizationError(message);
}
