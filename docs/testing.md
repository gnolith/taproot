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

`test/example.test.ts` runs the documented Codex Site example and queries its
Taproot-generated graph through Diamond SPARQL. `consumer:check` packs the
package, installs the tarball into a fresh temporary project with registry
Diamond and Miniflare dependencies, initializes a new D1 database, writes an
entity, and verifies the RDF through SPARQL using only public package exports.

`npm run check` is the complete local release-quality gate. Coverage thresholds
are enforced in `vitest.config.ts`; lowering them requires an explained review.
