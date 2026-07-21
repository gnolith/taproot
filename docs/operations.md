# Operations

## Initialize and migrate

Run `initializeTaproot(db)` before using a database. It is idempotent and
initializes Diamond too. Consumers that apply SQL migrations separately must
still run the initializer
after applying `0002`: legacy revision hashes require Web Crypto and cannot be
correctly produced by SQLite alone.

The v1-to-v2 migration backfills SHA-256 content/parent chains and audit
events, migrates RDF mapping v1 to v2, creates ownership records, and uses a
durable migration marker so an interrupted reprojection resumes safely.
`inspectTaprootSchema` checks tables, required columns, indexes, triggers, and
format versions. A failed inspection means the database is not usable by this
package. The consuming application decides how that affects startup or rollout.

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
