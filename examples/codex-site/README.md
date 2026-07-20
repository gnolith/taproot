# Codex Site example

Bind a Cloudflare D1 database as `DB`, apply Diamond's migrations followed by
`migrations/0001_taproot.sql`, and call `runTaprootDemo(env.DB)` from a trusted
setup route or test fixture.

`demo.ts` creates Properties and an Item, adds a qualified and referenced
statement, changes its rank, adds a `somevalue`, queries the truthy projection
through Diamond SPARQL, exports canonical JSON, and proves that a stale edit is
rejected. A production site should authenticate every mutation route; Taproot
deliberately does not own authentication or agent transport.
