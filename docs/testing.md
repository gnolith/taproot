# Testing strategy

Taproot's unit tests cover canonical Wikibase JSON validation, deterministic
serialization, and RDF mapping fixtures. Integration tests run against
Miniflare's Workerd D1 implementation and initialize Diamond and Taproot in the
same database.

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
entity, and verifies the RDF through SPARQL using only public package exports.

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
exception tracked in Cloudflare workers-sdk issue #14493. Remove the override
once a Miniflare release in Taproot's supported range declares a non-vulnerable
Sharp version and the full D1, interop, packed-consumer, Node 22/24, and audit
gates pass without it.

The override is qualified for Taproot's Miniflare D1 test use. It is not a claim
of general Cloudflare Images compatibility, nor a compatibility claim for
macOS, ARM, or musl environments.
