# Unified-search source events

Migration 0005 adds Taproot's persistence boundary between authoritative domain
writes and later search materialization. It is DDL-only: upgrading an exact
migration-0004 database creates an empty immutable event log and empty current
registry without scanning or backfilling canonical rows.

Each event contains only routing and consistency metadata: installation,
domain, one of the seven V1 source kinds, source ID, upsert/delete operation,
change class, opaque source revision and hash, authorization revision, search
generation, predecessor event/sequence, payload hash, and timestamp. It cannot
contain labels, text, statement IDs, visibility lists, SQL, or raw errors.

The current registry is keyed by `(installation_id, source_kind, source_id)`.
Its domain is immutable. Event rows reject update, delete, and replacement;
registry identity and domain reject mutation; registry sequence and search
generation must strictly advance. Replay lookup and ordered domain scans are
indexed.

## Atomic writer boundary

`createInstallationSearchSourceGuardV1` issues a process-local opaque
`InstallationSearchSourceGuardV1` bound to the exact database, installation,
domain, source kind, capability, and allowed change classes. The guard derives
installation, authorization revision, and current search generation from the
persisted authorization singleton. `batchWithSourceEvent` executes sibling
domain SQL, the generation CAS, immutable event, and current-registry CAS in
one `db.batch` transaction.

An exact `(installation, kind, source, revision)` replay with the same event
and payload hash is a no-op; sibling SQL is not repeated. A divergent replay
fails. New events require the exact persisted predecessor event and internal
sequence. Losing generation or predecessor races rolls the entire batch back.
Knowledge capabilities cannot be bound to this generic guard: canonical
Knowledge policy writes use their separate authorization guard, which advances
the shared authorization revision and search generation together.

Taproot Item writes append exactly one Item-root event to the same canonical
transaction. Metadata, statement, authorization-visibility, delete, redirect,
and restore changes never emit one event per statement. A later materializer
loads the authorized Item root and may derive Item plus Statement documents.

## Verification and baseline

`test/search-source-events.test.ts` covers exact 0004 migration, no backfill,
drift and rollback, Node SQLite restart, real Workerd D1 catalog parity, all
seven kind validators, opaque authority, replay, concurrent predecessor CAS,
generation counts, cross-domain/install misuse, disclosure canaries, indexed
lookup, bounded payloads, and Item-root cardinality.

Run `npm run baseline:search-source-events -- 100000` to reproduce the capped
Node SQLite ingest artifact in `benchmarks/search-source-events-100k.json`.
Latency is recorded for comparison; there is intentionally no SLA. CI
hard-gates cardinality, constant internal batch overhead, bounded metadata, and
indexed replay lookup.

This slice does not implement jobs, leasing, materialization, rebuild, health,
query/search execution, chunks, another domain's canonical persistence,
Seedbed assembly, semantic search, or Site provisioning/deployment. The
existing authorization projection outbox is unchanged and is not reused or
renamed as a search-event queue.
