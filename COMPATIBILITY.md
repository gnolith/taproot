# Wikibase compatibility target

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
- Audit policy, authentication, attribution identity semantics, and agent/MCP
  transport are host concerns; revision rows already accept optional actor and
  edit-summary strings.
