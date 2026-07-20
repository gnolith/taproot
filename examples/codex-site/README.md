# Codex Site example

Bind a Cloudflare D1 database as `DB`, apply Diamond's and Taproot's numbered
migrations, call `initializeTaproot`, and run `runTaprootDemo(env.DB)` from a
trusted setup route or test fixture.

`demo.ts` creates Properties and an Item, adds a qualified and referenced
statement, changes its rank, adds a `somevalue`, queries the truthy projection
through Diamond SPARQL, exports canonical JSON, proves that a stale edit is
rejected, and returns the attribution/audit and integrity records. A production
site should authenticate every mutation route and can enable
`requireAttribution`; Taproot deliberately does not own authentication or agent
transport.
