# Testing strategy

Taproot's unit tests cover canonical Wikibase JSON validation, deterministic
serialization, and RDF mapping fixtures. Integration tests run against
Miniflare's Workerd D1 implementation and initialize Diamond and Taproot in the
same database.

`test/search-contract.test.ts` pins the exact seven-kind V1 vocabulary and
filter matrix, strict limits and public shapes, Unicode/null/order canonical
vectors, cursor bindings, opaque projection authority, logical Statement
projection, Item no-omission splitting, mixed-scope partition/rejection,
hostile widening prevention, chunk trace/noncanonicality, and explicit
cross-domain projector guardrails. The packed consumer repeats the
public serialization, pure projection, and forged-authority checks from the
installed tarball.

`test/search-source-events.test.ts` qualifies migration 0005 on persisted
Node SQLite and real Workerd D1: exact predecessor, drift, no backfill, restart,
immutable catalog rules, seven-kind validation, opaque guard authority, exact
and divergent replay, predecessor races, rollback, generation cardinality,
Item-root statement/authorization/lifecycle events, disclosure canaries,
bounded payloads, and indexed lookup. The packed consumer repeats guard
nonconstructibility and one atomic source event from the installed tarball.
The reproducible capped 100k artifact records latency without imposing an SLA.

`test/search-materialization.test.ts` runs the same black-box lifecycle against
persisted native SQLite and real Workerd D1. It covers exact DDL-only 0006,
32-way claims, expired/crashed attempts, ABA rejection, stable Item/Statement
document identities, full CNF/filter/chunk persistence, replace-all removal,
delete/restore eligibility, dual-fanout shadow rebuild and atomic activation,
redacted blocked health, migration drift, and a true SQLite close/reopen.
It also proves that a term found only in Statement text returns both the
authorization-safe Item aggregate and native Statement result, plus honest
`healthy`, `building`, `blocked`, and `degraded` lifecycle states.
`npm run baseline:search-materialization` reproduces the checked 100k-root,
one-million-chunk indexed-path artifact without imposing an SLA. The packed
consumer exercises the guarded lifecycle from the installed tarball.

`test/external-search-migration.test.ts` applies exact migration 0007 on both
persisted engines, preserves the full staged document/visibility/filter/chunk
graph, enforces exactly seven staged kinds, and reopens the database.
`test/external-search-producers.test.ts` qualifies the fieldless mutation
handle, same-batch Workshop mutation+event, and data-only external materialization,
redacted adoption failures, resumable cursor reconstruction, and rejection of
forged, replayed, cross-kind, or stale-process handles.
The shared native/Workerd suite additionally commits 18 simultaneous Task,
Memory, and Prompt mutations, verifies a collision-free global generation
sequence, and covers same-source races, restart, and injected domain failure.

`test/content-search.test.ts` is shared public-search conformance on persisted
native SQLite and real Workerd D1. It proves distinct Item/Resource/Annotation
identity, injected external payload hydration and integrity, bounded independent
chunks, omitted/all and narrowed kinds, strict limits and cursor binding,
canonical hydration, immediate stale-revision invalidation, and durable
semantic-plan intake of content changed after estimation.

`test/snapshot.test.ts` restores canonical JSON, RDF quads/ownership, content,
authorization, and compatible derived search state into a freshly migrated
database while proving credential-shaped columns are absent.

`test/semantic-search.test.ts` runs deterministic OpenAI/Ollama-compatible HTTP
fakes, persisted/reopened exact SQLite vector conformance, authorization and
installation isolation, durable approval/state transitions, selected-generation
readiness, three-attempt circuits, redacted warning-once behavior, and healthy
lexical fallback. `npm run test:qdrant` pulls pinned
`qdrant/qdrant:v1.18.2@sha256:da65a06bc75e42702f80c992b99c5144b0fbd675ae7a96d2991de0bf957b7071`
for `linux/amd64` and runs real validate/probe/upsert/authorized-query/isolation/
delete conformance. `npm run baseline:hybrid-search` records
reproducible indexing, query, storage, memory, vector, batch, and token evidence
without asserting an unsupported SLA.

The machine-checked 89-row ownership map is
`docs/taproot-requirement-test-matrix.json`; `test/requirement-matrix.test.ts`
rejects missing, duplicate, or dangling evidence entries.

The Workerd suite exercises successful edits, malformed and oversized input,
optimistic conflicts, concurrent writers, migration, immutable history,
projection repair, shared RDF values, and injected RDF failures. The injected
failure proves that canonical JSON, revisions, audit events, search terms,
ownership, and Diamond quads roll back as one D1 batch.

`test/interop.test.ts` runs the documented local D1 and Diamond interoperability
example and queries its Taproot-generated graph through Diamond SPARQL.

`test/persistence.test.ts` exercises Diamond's Node SQLite adapter in memory
and on disk, including read-only planning, immutable identity, close/reopen,
same-adapter enforcement, late-batch rollback, and concurrent writers.
`consumer:check` packs the
package, installs the tarball into a fresh temporary project with registry
Diamond and Miniflare dependencies, initializes a new D1 database, writes an
entity, and verifies the RDF through privileged package-test SPARQL using only
public package exports. It additionally requires npm's complete installed tree
to contain exactly one `@gnolith/diamond@0.4.1` runtime and proves the
Statement-only Item aggregate query through packed Workerd D1. A second
disposable consumer compiles representative public types using TypeScript 5.9
with strict mode and `skipLibCheck: false`. This proves RDF interoperability,
not authorization of a user-facing SPARQL endpoint.

`npm run check` is the complete local package release-quality gate. Coverage
thresholds are enforced in `vitest.config.ts`; lowering them requires an
explained review. Miniflare/Workerd and packed-consumer success verifies the
package's supported D1 runtime contract, not assembly, provisioning, deployment,
or acceptance of a complete Gnolith Site. The Codex agent creating a Site owns
those checks.

## Miniflare dependency security

Miniflare is a development-only dependency used to qualify Taproot against its
supported Workerd D1 runtime. Taproot applies an exact root override of
`sharp@0.35.3` because Miniflare currently declares `sharp@0.34.5`, which is
affected by GHSA-f88m-g3jw-g9cj. This is a temporary upstream-compatibility
exception tracked in [Cloudflare workers-sdk PR #14493](https://github.com/cloudflare/workers-sdk/pull/14493).
Remove the override once a Miniflare release in Taproot's supported range
declares a non-vulnerable Sharp version and the full D1, interop,
packed-consumer, Node 22/24, and audit gates pass without it.

The override is qualified for Taproot's Miniflare D1 test use. It is not a claim
of general Cloudflare Images compatibility, nor a compatibility claim for
macOS, ARM, or musl environments.
