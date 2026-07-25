# API guide

The unified-search types, strict normalizers, deterministic serialization
utilities, and projection planners are documented in
[search-contract.md](search-contract.md). `createAuthorizedSearchServiceV1`
exposes the single relevance `search` operation plus owner hydration. Omitted
kinds cover all ready built-ins and registered external handles; explicit
kinds narrow; invalid handles, limits, and cursor bindings fail closed.
SPARQL remains a separate exact structured path.

The metadata-only persistence boundary is documented in
[search-source-events.md](search-source-events.md). It records authoritative
source changes. The separately guarded dormant lifecycle in
[search-materialization.md](search-materialization.md) materializes Taproot
Item, Statement, Resource, Annotation, and registered external roots.
Registered external producer mutation issuers accept explicit upsert/delete
operation metadata; delete owner mutations and their immutable source event
commit atomically.

`TaprootContentRepositoryV1` owns canonical Resource and Annotation CRUD,
revision reads, authorization, payload hydration, snapshots, and W3C Web
Annotation import/export. Resource payload bytes remain host-provided through
`PortableResourcePayloadStoreV1`.

`createSemanticSearchAdminV1` requires exact `search:admin` for configuration,
selection, reconnect, estimate, approval, run/resume, pause, stop, retry,
exclusion, retirement, deletion, and status. Provider secrets are closure-only
runtime inputs. `createOpenAICompatibleEmbeddingProviderV1`,
`createOllamaCompatibleEmbeddingProviderV1`, `createSqliteVectorIndexV1`, and
`createQdrantVectorIndexV1` are independent replaceable ports.

`createSearchMaterializationAdminGuardV1` requires the host-only Taproot write
capability and returns only bounded `initialize`, `run`, redacted `health`,
audited dead-work retry, and shadow-rebuild maintenance operations. Each call
also requires the exact current `search:admin` authorization context. No raw
job, document, claim token, indexed text, or query method is public.

## Persistence and migrations

Taproot accepts Diamond's runtime-neutral `SqliteDatabaseLike`; the exported
`D1DatabaseLike` remains a structurally compatible name for existing Site
consumers. `initializeTaproot(db, { baseIri })` initializes Diamond first, then
Taproot, and records the canonical absolute HTTP(S) base IRI on first use.
Later initialization may omit it; supplying a different identity fails closed.

`planTaprootMigrations(db)` and `inspectTaprootPersistence(db)` are read-only.
`applyTaprootMigrations(db, { baseIri })` applies the package-owned checksummed
manifest in the `@gnolith/taproot` ledger namespace. Known version-one layouts
are inspected before adoption. Unknown, partial, out-of-order, or
checksum-drifted histories raise typed migration/schema errors.

`AuthorizedTaprootReader` is the only application/search canonical read
boundary. It requires a host-created `AuthorizationContext` and host-issued
cursor codec; persisted policy is package-owned and cannot be injected. See
[`authorization.md`](authorization.md).

## Reads

Normal canonical hydration uses `getEntity`, `getEntityRevision`, and
`resolveEntity`. Authorized page APIs cover `listEntities`,
`listEntityRevisions`, `searchEntities`, and `listAuditEvents`; pass the opaque
cursor back unchanged. `getAuditEvent`, `exportEntities`, and all integrity
operations are also authorization-enforcing. Current policy gates every
disclosure; historical policy is intersected and can only narrow it. Integrity
and repair additionally require the exact `search:admin` capability.

## Writes

- `createItem`, `createProperty`, `importEntity`, `replaceEntity`, `revertEntity`
- `applyCommands` for multiple domain changes in one revision
- individual label, description, alias, sitelink, statement, qualifier,
  reference, and rank methods
- `softDeleteEntity`, `restoreEntity`, `redirectEntity`
- `repairEntityProjection`

All updates require `expectedRevision`. Public write helpers return a minimal
`MutationReceipt`, never canonical content, and require a
`InstallationAuthorizationGuard`, a current `AuthorizationContext` with exact
`knowledge:write`, and `CanonicalAuthorizationPolicyInput`. Policy changes
also require exact `knowledge:policy`. The process-local guard is issued using
a `TaprootHostWriteCapability` after authorization bootstrap and is bound to
the exact database object and normalized base IRI. Neither token can be
serialized or reused across bindings or installations. Redirects must target a live entity of the same type and cannot
create a cycle. `resolveEntity` follows a bounded chain and reports every hop.
`MutationReceipt.changed` is `true` only when the operation committed a new
canonical entity revision. An identical Item or Property label update returns
`changed: false`, preserves `previousRevision === newRevision`, and does not
advance RDF, authorization, source-event, search, or materialization state.
The Workshop port exposes the same required field on its `WriteResult`; callers
must consume it instead of inferring disposition from mutable counters.

`createStatement` and `createReference` build correctly shaped values. Import
accepts trusted explicit Q/P IDs and advances counters. `importEntities`
supports create-only or upsert mode and reports per-entity failures. An
authorized bulk import supplies one policy per entity. Those policies name the
sequential expected installation authorization revisions; after each success,
Taproot advances the context revision used for the next entity while preserving
the same authenticated principal, grants, and capabilities.

`createTaprootWorkshopPortV1` is the packed owner-integration boundary for
Workshop. Assembly binds it to an installation, exact database connection, and
opaque `TaprootHostWriteCapability`. It resolves an already-authenticated
principal identity into a live persisted `AuthorizationContext` and provides
bounded opaque-cursor statement, Resource, and Annotation revision history.
Every read checks the current authorization fence before lookup and again after
hydration; the port exposes neither credentials nor storage/query primitives.

The same port provides item, property, entity-command, Resource, and Annotation
mutations. Callers supply a required idempotency key and, for updates, the
expected revision; Taproot derives new authorization policy from the live
principal/workspace context and preserves existing policy on updates. Workshop
therefore never constructs `CanonicalAuthorizationPolicyInput`, and persistent
receipts make successful retries stable across process restarts.

`mutateEntity` accepts one to 200 ordered `{ command, authoredText }` entries
and commits them as one revision. Taproot carries each authored text into the
corresponding statement command where applicable and records the complete
ordered list in audit metadata; attribution and request identity are derived
from the live principal and idempotency key.

`hydrateResource(resourceId, revision, context, signal?)` hydrates the exact
authorized historical descriptor, verifies its declared length and SHA-256
digest, and rejects payloads above the configured bounded byte limit. Blob
references require a `payloadStore` when the port is assembled.

`Statement.text` is required, non-whitespace authored text describing that
exact structured revision. `addStatement` and `replaceStatement` receive it on
the statement. Rank, qualifier, and reference mutations receive a separate
required text argument so stale text is never silently retained.
`replaceEntity` and `revertEntity` use `StatementRevisionEdit`; its
`statementTexts` map must cover every resulting statement ID exactly. Imports
validate text on every statement, while upsert imports treat the complete
imported statements as the caller's explicit resupply.

## Edit context

An edit can contain structured `attribution`, `editSummary`, sorted/deduplicated
`tags`, and a `requestId`. Attribution kinds are `human`, `agent`, `import`, or
`system`. The legacy `actor` string remains accepted and is normalized to a
human attribution record.

Public `TaprootWriteOptions` support `requireAttribution`, `clock`, `createId`,
`observe`, and bulk limits. They deliberately reject validators, RDF factories,
and a caller-selected entity-size limit because those can observe preexisting
canonical content during a mutation. Hosts perform domain validation over
separately authorized input. Observers cannot fail or roll back committed
writes. Host assembly must not expose the database binding, host capability,
guard, or authorization context to request, user, agent, or MCP code.

`bootstrapTaprootAuthorization` initializes a pristine database once.
`createInstallationAuthorizationGuard` issues the normal-write guard.
The guard exposes only live-state inspection; it accepts no SQL or foreign
statements. Canonical writes and policy advances use bounded Taproot operations.
External search producers coordinate through namespace-bound registration
capabilities and sealed one-shot owner mutation participants.
`RegisteredExternalProducerV1.currentPredecessor(sourceId)` returns the exact
frozen `{ eventId, sequence }` required to seal the next mutation, or `null`
before the first event. It remains scoped to that registered installation and
external kind. After a process restart, the exact deterministic durable owner
registration can be rebound to a new live capability; same-connection
duplicates and owner mismatches remain rejected.
`inspectTaprootAuthorizationReadiness`,
`planTaprootAuthorizationBackfill`, and
`applyTaprootAuthorizationBackfill` are host-controlled, exact
`search:admin` maintenance operations for bounded legacy migration.

All domain failures extend `TaprootError` and expose a stable uppercase
snake-case `code` in addition to their exported class for `instanceof` checks.
