# Operations

Migration compatibility is defined from released Taproot catalogs only.
Databases created by unmerged draft branches or intermediate pull-request
heads are development artifacts and are not supported upgrade predecessors.

## Initialize and migrate

Run `initializeTaproot(db, { baseIri })` before using a new database. The
absolute HTTP(S) base IRI is stored as permanent database identity and cannot
be replaced by a later hostname or runtime setting. Afterward,
`initializeTaproot(db)` is idempotent and initializes Diamond too. Do not apply
the historical numbered SQL files directly in 0.3; hosts orchestrate the
package-owned plan/apply/initialize APIs because legacy revision hashes and
adoption checks cannot be correctly produced by SQLite alone.

The v1-to-v2 migration backfills SHA-256 content/parent chains and audit
events, migrates RDF mapping v1 to v2, creates ownership records, and uses a
durable migration marker so an interrupted reprojection resumes safely.
`inspectTaprootSchema` checks tables, required columns, indexes, triggers, and
format versions. A failed inspection means the database is not usable by this
package. The consuming application decides how that affects startup or rollout.

Canonical JSON migration 3 requires authored statement text. It upgrades
empty or already-conforming corpora atomically. If any current or historical
revision has a statement without nonblank `text`, migration fails closed and
leaves canonical JSON version 1 recorded. An operator must use a separately
authorized curation/import process to supply genuinely authored text; Taproot
does not infer a fallback from structured statement fields.
The validation scans current entities and immutable history with deterministic
100-row keyset pages, so migration does not require an unbounded D1 result set.

Migration 4 adds package-owned canonical authorization policy. Fresh
installations call `bootstrapTaprootAuthorization` once. Existing canonical
rows remain quarantined until an exact `search:admin` caller plans and applies
a bounded full-history backfill manifest containing every revision content hash
and explicit entity/statement policy. No visibility is inferred, and policy,
outbox, audit, authorization revision, and search generation publish in one
batch.

Migration 5 adds the immutable unified-search source-event log and current
source registry. The only supported predecessor is the exact released
migration-0004 catalog. The migration is DDL-only and performs no backfill;
existing canonical rows receive a first root event only on a later authorized
mutation. Event and registry publication share the authoritative domain write
transaction and generation CAS. These tables are not themselves a job queue.

Migration 6 accepts only the exact migration-5 catalog and is DDL-only. It adds
persisted corpora, checkpoints, bounded projection jobs, immutable transitions,
invisible stages, complete manifests, root heads/tombstones, shadow rebuild
enumeration, and administrative audit. It does not backfill source events or
start a worker. A host-created exact `search:admin` context can initialize and
run bounded work through `createSearchMaterializationAdminGuardV1`; ordinary
request data cannot construct that guard. Process hosts may repeatedly invoke
the same runner, while D1 hosts may drain bounded pages per request or scheduled
event. See [search-materialization.md](search-materialization.md).

Hosts can call `planTaprootMigrations(db)`,
`inspectTaprootPersistence(db)`, and
`applyTaprootMigrations(db, { baseIri })`. Planning and inspection are
read-only. Taproot owns its schema, identity, and migration namespace; Seedbed
owns local CLI, file path, process lifecycle, and Docker assembly, while a
Codex Site host owns D1 and Site assembly.

## Integrity and repair

Authorized `verifyAuditChain(id)` verifies revision continuity, every content hash and
parent link, the chain head, and corresponding audit events.
`inspectEntityIntegrity(id)` also compares current JSON, revision JSON, terms,
RDF, and ownership. `inspectTaprootIntegrity` scans by cursor.

Authorized, exact `search:admin`-gated `repairEntityProjection` atomically rebuilds terms, RDF, and ownership without
changing canonical content or inventing a new content revision. It appends a
`repair` audit event, requires current policy plus an authorization-revision
CAS, and advances search generation. It does not rewrite damaged immutable history; restore
such data from backup and investigate if hash verification fails.

## Backup and restore

Back up the whole D1 database to preserve atomic boundaries. Canonical entities
can also be exported as authorization-filtered newline-delimited JSON with
`AuthorizedTaprootReader.exportEntities`, but that
is a knowledge export, not a backup of attribution, revisions, deletions,
redirects, or audit history.

After database restore, run schema inspection and paginated integrity checks.
After JSON-only import, projections are generated during each import.

Taproot documents persistence semantics but does not select or provision a D1
database, run remote migrations, configure backups, deploy an application, or
accept a complete Gnolith Site. The Codex agent creating a Site owns those
operational decisions and checks.

## Limits and failure behavior

Writes are atomic per entity. Bulk import is deliberately not a cross-entity
transaction; retry failed entries using their result indexes. Default limits:
1.8 MB canonical JSON, 100 bulk entities, 100 commands per revision, and 500
rows per page. Diamond separately enforces its atomic RDF payload bound.

Revision and audit rows have database triggers rejecting UPDATE and DELETE.
Projection repair is safe under shared RDF values because orphan removal checks
quad ownership inside the same D1 transaction.
