# Changelog

## Unreleased

- **Breaking 0.3 API:** removed `TaprootRepository`, `createTaproot`, and every
  unscoped canonical read helper from the normal package export. Canonical
  entity, history, list, term-search, audit, export, integrity, and repair
  access now exists only through mandatory `AuthorizedTaprootReader` context.
- Added host-issued non-extractable AES-GCM cursor capability, authenticated
  cursors bound to caller/grants/query/filter/auth revision/data generation,
  fixed-size plaintext padding, identifier-only candidate scans, denied-heavy
  page filling, and final authorization rechecks. Revision and audit generation
  invalidate cursors after writes and repair. Stale, tampered, and cross-context
  cursors fail generically.
- Public mutation helpers now return minimal receipts and reject validator/RDF
  factory callbacks and configurable entity-size probes, so write configuration
  cannot observe preexisting canonical content. They require a process-local
  opaque installation authorization guard bound to the exact database object
  and installation base IRI. Normal writes require current `knowledge:write`;
  policy changes require orthogonal `knowledge:policy`. Raw repository
  internals are not package-exported.
- Added host-created authorization contexts, canonical CNF visibility scopes,
  lossless scope intersection, portable fingerprints, explicit `search:admin`
  checks, and fail-closed pre/post-hydration canonical reads.
- Added checksummed migration 4 with immutable installation authorization
  state, current and per-revision entity/statement policy, atomic projection
  outbox and counter advances, fail-closed legacy quarantine, and bounded
  hash-attested `search:admin` backfill. Unique durable advance IDs prevent
  same-target ABA races for canonical and cross-package ordered batches.
- Runtime JavaScript writes now fail closed when authorization metadata is
  omitted, authorize before loading existing canonical state, validate redirect
  targets and historical reverts against current policy, and preserve generic
  denial behavior for missing, stale, or inaccessible targets.
- Cross-package authorization fencing is guard-executed and inseparable from
  the ordered database batch. Authorization singleton/audit rows reject
  replacement, readiness verifies current and historical statement-policy
  coverage, and authorized bulk import advances its context between entities.
- Added host-issued fence-only domain guards bound to one exact non-Knowledge
  capability. Task/Memory-style writes can share the installation revision
  without borrowing Knowledge authority or advancing counters; Knowledge
  advances require orthogonal policy authority and bind the prior durable
  advance ID.
- Authorization readiness and persisted sources now require exact parity
  between mutable current policy and its immutable matching revision, and
  recompute historical statement coverage/effective visibility before use.
  Operational inspection also validates exact trigger definitions.

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
