# API guide

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

`TaprootRepository` is the primary API; equivalent top-level functions are
exported for request-scoped use.

## Reads

- `getEntity`, `resolveEntity`, `getEntityRevision`
- `listEntities`, `listEntityRevisionsPage`, `searchEntitiesPage`
- `getAuditEvent`, `listAuditEvents`, `verifyAuditChain`
- `inspectEntityIntegrity`, `inspectTaprootIntegrity`

Page APIs return `{ items, cursor }`. Pass the opaque cursor back unchanged.
Entity and revision cursors are keyset cursors. Search cursors are bounded
offset cursors and should be consumed promptly when the search index is being
edited concurrently.

## Writes

- `createItem`, `createProperty`, `importEntity`, `replaceEntity`, `revertEntity`
- `applyCommands` for multiple domain changes in one revision
- individual label, description, alias, sitelink, statement, qualifier,
  reference, and rank methods
- `softDeleteEntity`, `restoreEntity`, `redirectEntity`
- `repairEntityProjection`

All updates require `expectedRevision`. Redirects must target a live entity of
the same type and cannot create a cycle. `resolveEntity` follows a bounded
chain and reports every hop.

`createStatement` and `createReference` build correctly shaped values. Import
accepts trusted explicit Q/P IDs and advances counters. `importEntities`
supports create-only or upsert mode and reports per-entity failures.

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

Set `requireAttribution`, `validators`, `clock`, `createId`, `observe`, entity
size, and bulk limits in `TaprootOptions`. Validators run before the D1 batch.
Observers cannot fail or roll back committed writes.

All domain failures extend `TaprootError` and expose a stable uppercase
snake-case `code` in addition to their exported class for `instanceof` checks.
