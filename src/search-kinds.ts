import type { D1DatabaseLike } from './sqlite-types.js';
import type { TaprootHostWriteCapability } from './assembly-authority.js';
import { assertTaprootHostWriteCapabilityInternal } from './assembly-authority.js';
import { InvalidAuthorizationError } from './errors.js';

export const BUILT_IN_SEARCH_KINDS = Object.freeze([
  'item',
  'statement',
  'resource',
  'annotation',
] as const);

export type BuiltInSearchKind = (typeof BUILT_IN_SEARCH_KINDS)[number];

export interface ExternalSearchKind {
  readonly namespace: string;
  readonly localName: string;
}

export interface ExternalProducerRegistrationCapability {
  readonly registrationId: string;
  readonly kind: ExternalSearchKind;
}

export type SearchKind = BuiltInSearchKind | ExternalSearchKind;

export interface ExternalOwnerTransactionAdapterV1 {
  readonly kind: 'taproot-external-owner-transaction-adapter-v1';
  /**
   * The adapter retains all owner knowledge. The returned values must be
   * prepared statements created by the exact registered connection; the
   * declaration deliberately exposes neither SQL nor a statement type.
   */
  prepare(ownerMutationToken: unknown): Promise<readonly unknown[]>;
}

export interface RegisterExternalProducerKindInputV1 {
  installationId: string;
  namespace: string;
  localName: string;
  ownerDomain: string;
  adapter: ExternalOwnerTransactionAdapterV1;
}

export interface RegisteredExternalProducerKindV1 {
  readonly kind: ExternalSearchKind;
  readonly registration: ExternalProducerRegistrationCapability;
}

interface KindBinding {
  db: D1DatabaseLike;
  installationId: string;
  registrationId: string;
  namespace: string;
  localName: string;
  ownerDomain: string;
  storageKey: string;
  adapter: ExternalOwnerTransactionAdapterV1;
}

const kindBindings = new WeakMap<object, KindBinding>();
const registrationBindings = new WeakMap<object, KindBinding>();
const liveRegistrations = new WeakMap<
  object,
  Map<string, ExternalProducerRegistrationCapability>
>();

const normalizedNamespace = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const normalizedLocalName = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u;
const normalizedOwner = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const reserved = new Set([
  'annotation',
  'builtin',
  'external',
  'gnolith',
  'item',
  'resource',
  'statement',
  'taproot',
]);

export async function registerExternalProducerKindV1(
  db: D1DatabaseLike,
  options: { baseIri: string },
  authority: TaprootHostWriteCapability,
  raw: RegisterExternalProducerKindInputV1,
): Promise<RegisteredExternalProducerKindV1> {
  assertTaprootHostWriteCapabilityInternal(db, options, authority);
  const installationId = token(raw.installationId, 'installationId', 128);
  const namespace = name(raw.namespace, 'namespace', normalizedNamespace, 96);
  const localName = name(raw.localName, 'localName', normalizedLocalName, 96);
  const ownerDomain = name(raw.ownerDomain, 'ownerDomain', normalizedOwner, 96);
  if (
    reserved.has(namespace) ||
    reserved.has(localName) ||
    namespace.startsWith('taproot.') ||
    namespace.startsWith('gnolith.')
  )
    denied('external kind uses a reserved name');
  if (
    !raw.adapter ||
    raw.adapter.kind !== 'taproot-external-owner-transaction-adapter-v1' ||
    typeof raw.adapter.prepare !== 'function'
  )
    denied('external owner transaction adapter is invalid');
  const state = await db
    .prepare(
      `SELECT installation_id FROM taproot_installation_authorization
       WHERE installation_id = ?`,
    )
    .bind(installationId)
    .all<{ installation_id: string }>();
  if (state.results[0]?.installation_id !== installationId)
    denied('external kind installation is not initialized');
  const storageKey = externalStorageKey(namespace, localName);
  const existing = await db
    .prepare(
      `SELECT registration_id, owner_domain
       FROM taproot_external_search_kind_registrations
       WHERE installation_id = ? AND storage_key = ?`,
    )
    .bind(installationId, storageKey)
    .all<{ registration_id: string; owner_domain: string }>();
  const registrationId = await stableRegistrationId(
    installationId,
    namespace,
    localName,
    ownerDomain,
  );
  const persisted = existing.results[0];
  if (persisted) {
    if (
      persisted.registration_id !== registrationId ||
      persisted.owner_domain !== ownerDomain
    )
      denied('external kind registration does not match the durable owner');
    if (liveRegistrations.get(db)?.has(registrationId))
      denied('external kind is already registered');
    return issueRegistrationCapability({
      db,
      installationId,
      registrationId,
      namespace,
      localName,
      ownerDomain,
      storageKey,
      adapter: raw.adapter,
    });
  }
  await db
    .prepare(
      `INSERT INTO taproot_external_search_kind_registrations(
         installation_id, registration_id, storage_key, namespace,
         local_name, owner_domain, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      installationId,
      registrationId,
      storageKey,
      namespace,
      localName,
      ownerDomain,
      new Date().toISOString(),
    )
    .run();
  return issueRegistrationCapability({
    db,
    installationId,
    registrationId,
    namespace,
    localName,
    ownerDomain,
    storageKey,
    adapter: raw.adapter,
  });
}

function issueRegistrationCapability(
  binding: KindBinding,
): RegisteredExternalProducerKindV1 {
  const { db, registrationId, namespace, localName } = binding;
  const kind = Object.freeze({ namespace, localName });
  const registration = Object.freeze({ registrationId, kind });
  kindBindings.set(kind, binding);
  registrationBindings.set(registration, binding);
  let byId = liveRegistrations.get(db);
  if (!byId) {
    byId = new Map();
    liveRegistrations.set(db, byId);
  }
  byId.set(registrationId, registration);
  return Object.freeze({ kind, registration });
}

/** @internal */
export function externalKindBindingInternal(
  registration: ExternalProducerRegistrationCapability,
): KindBinding {
  const binding = registrationBindings.get(registration);
  if (!binding || registration.kind !== findKindForBinding(binding))
    denied('external producer registration capability is invalid');
  return binding;
}

/** @internal */
export function searchKindStorageKeyInternal(
  kind: SearchKind,
  db: D1DatabaseLike,
  installationId: string,
): string {
  if (typeof kind === 'string') {
    if (!(BUILT_IN_SEARCH_KINDS as readonly string[]).includes(kind))
      denied('search kind is unknown');
    return kind;
  }
  const binding = kindBindings.get(kind);
  if (
    !binding ||
    binding.db !== db ||
    binding.installationId !== installationId
  )
    denied('external search kind is invalid for this installation');
  return binding.storageKey;
}

/** @internal */
export function publicSearchKindInternal(
  db: D1DatabaseLike,
  installationId: string,
  storageKey: string,
): SearchKind | null {
  if ((BUILT_IN_SEARCH_KINDS as readonly string[]).includes(storageKey))
    return storageKey as BuiltInSearchKind;
  for (const registration of liveRegistrations.get(db)?.values() ?? []) {
    const binding = registrationBindings.get(registration);
    if (
      binding?.installationId === installationId &&
      binding.storageKey === storageKey
    )
      return registration.kind;
  }
  return null;
}

/** @internal */
export function registrationForStorageKeyInternal(
  db: D1DatabaseLike,
  installationId: string,
  storageKey: string,
): ExternalProducerRegistrationCapability | null {
  for (const registration of liveRegistrations.get(db)?.values() ?? []) {
    const binding = registrationBindings.get(registration);
    if (
      binding?.installationId === installationId &&
      binding.storageKey === storageKey
    )
      return registration;
  }
  return null;
}

/** @internal */
export function isBuiltInStorageKindInternal(
  value: string,
): value is BuiltInSearchKind {
  return (BUILT_IN_SEARCH_KINDS as readonly string[]).includes(value);
}

function findKindForBinding(binding: KindBinding): ExternalSearchKind | null {
  for (const registration of liveRegistrations.get(binding.db)?.values() ?? [])
    if (registrationBindings.get(registration) === binding)
      return registration.kind;
  return null;
}

function externalStorageKey(namespace: string, localName: string): string {
  return `external:${namespace.length}:${namespace}:${localName}`;
}

async function stableRegistrationId(
  installationId: string,
  namespace: string,
  localName: string,
  ownerDomain: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify([installationId, namespace, localName, ownerDomain]),
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `registration-${[...digest]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

function name(
  value: unknown,
  field: string,
  pattern: RegExp,
  maximum: number,
): string {
  const normalized = token(value, field, maximum);
  if (
    normalized !== normalized.normalize('NFKC') ||
    normalized !== normalized.toLowerCase() ||
    !pattern.test(normalized)
  )
    denied(`${field} is not normalized`);
  return normalized;
}

function token(value: unknown, field: string, maximum: number): string {
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
