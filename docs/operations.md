# Operations

## Initialize and migrate

Run `initializeTaproot(db, { baseIri })` before using a new database. The
absolute HTTP(S) base IRI is stored as permanent database identity and cannot
be replaced by a later hostname or runtime setting. Afterward,
`initializeTaproot(db)` is idempotent and initializes Diamond too. Do not apply
the historical numbered SQL files directly in 0.2; hosts orchestrate the
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

Hosts can call `planTaprootMigrations(db)`,
`inspectTaprootPersistence(db)`, and
`applyTaprootMigrations(db, { baseIri })`. Planning and inspection are
read-only. Taproot owns its schema, identity, and migration namespace; Seedbed
owns local CLI, file path, process lifecycle, and Docker assembly, while a
Codex Site host owns D1 and Site assembly.

## Integrity and repair

`verifyAuditChain(id)` verifies revision continuity, every content hash and
parent link, the chain head, and corresponding audit events.
`inspectEntityIntegrity(id)` also compares current JSON, revision JSON, terms,
RDF, and ownership. `inspectTaprootIntegrity` scans by cursor.

`repairEntityProjection` atomically rebuilds terms, RDF, and ownership without
changing canonical content or inventing a new content revision. It appends a
`repair` audit event. It does not rewrite damaged immutable history; restore
such data from backup and investigate if hash verification fails.

## Backup and restore

Back up the whole D1 database to preserve atomic boundaries. Canonical entities
can also be exported as newline-delimited JSON with `exportEntities`, but that
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
