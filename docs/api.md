# API guide

The unified-search types, strict normalizers, deterministic serialization
utilities, and projection planners are documented in
[search-contract.md](search-contract.md). `createAuthorizedSearchServiceV1`
exposes the single relevance `search` operation plus owner hydration. Omitted
kinds cover all seven kinds; explicit kinds narrow; invalid kinds, limits, and
cursor bindings fail closed. SPARQL remains a separate exact structured path.

The metadata-only persistence boundary is documented in
[search-source-events.md](search-source-events.md). It records authoritative
source changes. The separately guarded dormant lifecycle in
[search-materialization.md](search-materialization.md) materializes Taproot
Item, Resource, Annotation, and registered Workshop roots.

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

`createStatement` and `createReference` build correctly shaped values. Import
accepts trusted explicit Q/P IDs and advances counters. `importEntities`
supports create-only or upsert mode and reports per-entity failures. An
authorized bulk import supplies one policy per entity. Those policies name the
sequential expected installation authorization revisions; after each success,
Taproot advances the context revision used for the next entity while preserving
the same authenticated principal, grants, and capabilities.

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
The guard can also execute an ordered cross-package database batch behind an
exact-revision fence or an inseparable authorization advance. It never returns
raw fence or advance statements to the caller.
`createInstallationDomainMutationGuard` issues a separate fence-only opaque
guard bound at host assembly to one exact non-Knowledge domain and capability.
Its batches return only the domain-statement results plus the fenced counters;
they do not advance either counter. Knowledge advances require both
`knowledge:write` and `knowledge:policy`.
`createInstallationSearchSourceGuardV1` issues an opaque non-Knowledge guard
bound to one database, installation, domain, source kind, capability, and set
of change classes. Its `batchWithSourceEvent` method atomically commits sibling
domain SQL, one persisted search-generation advance, one immutable source
event, and the current source registry. Exact replay is a no-op; divergent or
stale-predecessor replay fails.
`inspectTaprootAuthorizationReadiness`,
`planTaprootAuthorizationBackfill`, and
`applyTaprootAuthorizationBackfill` are host-controlled, exact
`search:admin` maintenance operations for bounded legacy migration.

All domain failures extend `TaprootError` and expose a stable uppercase
snake-case `code` in addition to their exported class for `instanceof` checks.
