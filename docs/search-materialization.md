# Unified-search materialization lifecycle

Migration `0006-unified-search-materialization-lifecycle` is additive,
DDL-only, requires the exact `0005` catalog, advances schema version 4 to 5,
and never backfills source events. Search administration explicitly initializes
the first corpus and enqueues the current registry through bounded pages.

An opaque host-issued `SearchMaterializationAdminGuardV1` exposes bounded
running, redacted health, dead-job retry, shadow rebuild start, and guarded
activation. Every call requires current installation `search:admin` authority.
No public API returns claim tokens, raw stages, or canonical claims. The public
search service reads only committed current heads and returns bounded snippets.

## Projection and visibility

Item source events load the exact current persisted Item, content hash,
revision, entity policy, and complete Statement policy set. A replacement stage
contains one stable `item` document slot plus one stable
`statement:<statement-id>` slot per current Statement. `documentId` depends on
installation, semantic slot, root reference, and canonical reference—not the
event, revision, corpus, or authorization fingerprint. Surviving documents keep
their IDs across revisions; removed Statements disappear because each stage is
a complete replace-all root image.

Documents retain separate root and canonical references. Their closed filter
metadata is normalized into exact filter rows. Complete normalized CNF clauses
and atoms are persisted without flattening. Chunk text must equal its document
slice and every trace range is fenced inside both the document and chunk.
Projection limits remain 1.8 MB and 512 chunks per document; overflow fails.

## Leasing, staging, and current-state fencing

Claims use random 128-bit tokens plus monotonically increasing claim
generations. Every stage/finalize predicate binds both, preventing ABA after
expiry and reclaim. Attempts back off deterministically, become dead after five
failures, and require guarded admin retry. Transition history is immutable and
stores only token hashes and bounded error codes.

Stages are invisible while built in bounded SQL batches. A verified manifest
pins document/chunk counts and hashes. Finalization is one atomic root-head
pointer swap, so replace-all and zero-document deletion never expose a partial
stage. New source events atomically mark older active and shadow heads
ineligible before projection work begins. Finalize rechecks the exact current
0005 event, root revision/hash, and authorization revision; unrelated global
counter advances do not starve the root.

## Shadow rebuild

A rebuild captures a source-event watermark and creates a shadow corpus.
Baseline enumeration pages over durable registry keys while all new source
events fan out to active and shadow corpora. Readiness requires enumeration
completion, no nonterminal jobs, and an exact registry-to-head anti-join with no
missing or stale materialized root. Standalone Statement registry rows are
excluded from that anti-join because their completed jobs are explicitly
covered by the containing Item root. Activation rechecks the stored readiness
watermark, job set, anti-join, and expected corpus pointers in the same batch,
atomically swaps the active corpus, increments cursor generation, and records
immutable admin audit.

Item stages include Item and Statement documents completely; standalone
Statement source events are coalesced as Item-root-owned rather than
dead-lettered or duplicated. Migration 0007 adds host-sealed Workshop Task,
Memory, and Prompt producers. Their callbacks return only bounded canonical data,
authorization data, and projection fields; they receive no SQL, database,
lifecycle guard, mutation handle, or caller-shaped authorization context.
Taproot derives hashes, identifiers, authority envelopes, and chunks.

Producer manifests and adoption progress are durable and immutable/audited.
Each corpus pins an exact fingerprint. A process restart must reconstruct the
matching callback registration; missing or mismatched registrations leave jobs
pending at attempt zero and appear dynamically in `blockedProducerKinds`.
`sourcePolicyRevision` remains distinct from the live installation
`authorizationRevision` through source, job, stage, and head fences. Migration
0008 adds Taproot-native Resource and Annotation producers. Textual external
Resource payloads are loaded only through the injected portable payload-store
capability, with byte and SHA-256 integrity fences before projection.

## Qualification

The same black-box lifecycle suite runs on persisted Node SQLite and real
Miniflare/Workerd D1. It covers exact migrations, 0006 staged-graph
preservation, producer adoption/reconstruction, 32-way reclaim contention,
crashed-stage recovery, stale ABA tokens, stable IDs, replace-all removal,
immediate stale fencing, mixed CNF, dual fanout, no-hole activation, and health
redaction. The reproducible no-SLA baseline records 100,000 roots and 1,000,000
chunks and hard-gates indexed visible-root, readiness anti-join, and claim
plans.
