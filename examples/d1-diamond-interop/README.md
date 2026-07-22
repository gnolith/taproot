# Local D1 and Diamond interoperability example

Pass a D1-compatible database to `runTaprootInteropDemo(db)`. The demo
initializes Taproot and Diamond in the same database, creates Properties and an
Item, applies revision-guarded edits, and queries Taproot's RDF projection
through Diamond SPARQL. The SPARQL call is a package interoperability probe
over a privileged database binding, not an authorization-safe endpoint.

The automated test runs this example locally with Miniflare's Workerd D1
implementation. It verifies the published package's D1 and Diamond contracts;
it does not assemble, provision, deploy, or accept a complete Gnolith Site.
Those responsibilities belong to the Codex agent creating that Site.
