# Changelog

## Unreleased

- Added required, explicitly authored nonblank `Statement.text` to canonical
  JSON and to every logical statement mutation.
- Added canonical JSON migration 3. Existing databases with no unauthored
  statements upgrade atomically; persisted statements without text fail closed
  rather than receiving inferred fallback prose.
- Whole-entity replacement and historical revert now require an exact
  statement-ID-to-text resupply map, preventing silent stale-text carry.

## 0.2.0

- Added a runtime-neutral SQLite persistence surface while retaining D1
  compatibility types and injection.
- Added checksummed Taproot migration plan, inspect, conservative adoption,
  and apply APIs.
- Made the canonical HTTP(S) base IRI a durable, immutable database identity.
- Added Workerd D1 and process-local Node SQLite parity coverage for reopen,
  rollback, and concurrent writers.

## 0.1.0

- Complete Wikibase Item/Property JSON model and validated editing API.
- Atomic current entities, immutable revisions, terms, RDF, and ownership.
- Structured attribution, tags, request correlation, audit events, and
  SHA-256 parent chains.
- Lifecycle history, redirect resolution/cycle prevention, cursor reads,
  multi-command edits, bounded bulk import/upsert, and NDJSON export.
- Schema/RDF migration, integrity inspection, audit verification, and repair.
- Wikibase-compatible truthy/full RDF mapping version 2 and shared-value safety.
- Host validators, attribution enforcement, observations, deterministic test
  injection, Workerd/D1 tests, Node 22/24 CI, and pack validation.
