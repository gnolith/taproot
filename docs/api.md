# API guide

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
