# Wikibase compatibility target

Taproot 0.3.x requires `@gnolith/diamond` 0.4.0 exactly. Existing Cloudflare D1
objects remain compatible with the exported `D1DatabaseLike` surface. New
embedders may use the equivalent `SqliteDatabaseLike`; both require one
adapter/connection with ordered atomic batch semantics.

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
- Search is a deterministic D1 term projection using case-insensitive
  substring matching. FTS5 is not required.
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
