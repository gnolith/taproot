# Wikibase compatibility target

Taproot 0.4.1 requires `@gnolith/diamond` 0.4.1 exactly. Existing Cloudflare D1
objects remain compatible with the exported `D1DatabaseLike` surface. New
embedders may use the equivalent `SqliteDatabaseLike`; both require one
adapter/connection with ordered atomic batch semantics.

The exact Diamond pin is the public-registry artifact qualified by Taproot's
native SQLite, Workerd D1, migration, prepared-patch, ledger, packed-consumer,
and release gates. It also makes npm converge on one Diamond runtime instead of
permitting a second compatible-looking copy.

The supported real-Qdrant conformance matrix is currently `linux/amd64` with
`qdrant/qdrant:v1.18.2@sha256:da65a06bc75e42702f80c992b99c5144b0fbd675ae7a96d2991de0bf957b7071`.
That platform-specific manifest is what CI and local release qualification run;
other architectures are not claimed by this matrix.

Fresh databases require an explicit durable absolute HTTP(S) base IRI. A
version-one database is adopted only when its known table and version markers
match the supported legacy layout; arbitrary partial schemas fail closed.

Taproot targets the canonical entity shapes and RDF vocabulary paths used by
the Wikibase API/RDF model, with site-owned entity/property namespaces. The
fixtures under `test/fixtures` are the named interoperability baseline.

Intentional differences:

- Taproot is a library over D1, not a MediaWiki or Wikibase HTTP server.
- Local Q/P IDs, base IRI, revision numbers, statement IDs, and reference
  hashes belong to the site. Imported values are preserved; Taproot does not
  call Wikidata to resolve or rewrite them.
- Sitelinks round-trip in canonical JSON but are not wiki-page storage and do
  not emit MediaWiki page metadata.
- Redirect and soft-delete state live beside canonical JSON and project only
  lifecycle RDF; deleted content remains available in immutable revisions.
- Unified search uses deterministic portable lexical ranking over committed
  materialized documents and can augment it with a complete selected semantic
  generation. FTS5 and a hosted vector service are not required; SQLite exact
  vectors are the portable baseline.
- Taproot stores attribution claims but does not authenticate them. Normal
  canonical reads require a host-created authorization context and use
  Taproot's persisted canonical policy. Authentication, principals,
  memberships, sessions, and agent/MCP transport remain host concerns.
- The compatibility target is Wikibase core Items and Properties. Lexemes,
  Forms, Senses, EntitySchemas, MediaInfo, MediaWiki page metadata, and
  normalized external-ID formatter URLs are not claimed as supported entity
  surfaces.
- Item/Property statements can nevertheless store and project the standard
  `wikibase-lexeme`, `wikibase-form`, `wikibase-sense`, and `entity-schema`
  link datatypes without claiming storage for those target entity documents.
- Math, musical notation, geo-shape, and tabular-data values round-trip and
  project with Wikibase property types. Geo-shape/tabular-data values use
  Commons data IRIs; availability of those external resources is outside this
  package.
- Taproot adds a site-owned mapping-version triple and retains
  `schema:isBasedOn` beside standard `prov:wasDerivedFrom` for backward
  compatibility. These additive triples do not change Wikibase query paths.
- Shared full-value/reference RDF nodes are reference-owned internally so
  incremental edits never remove a quad still used by another entity. The
  ownership table is projection bookkeeping, not an authoritative statement
  store.

Interoperability means canonical Item/Property JSON round-trip and equivalent
Wikibase query paths (`wdt`, `p`, `ps`, `psv`, `pq`, `pqv`, `pr`, `prv`,
`wdno`) under a site-owned base IRI. It does not mean Taproot implements the
MediaWiki/Wikibase HTTP APIs or every extension entity type.
