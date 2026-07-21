# Product scope

Taproot exists so a D1-backed application can own a Wikibase-style knowledge graph
and query it through Diamond without operating MediaWiki or another external
knowledge service.

Version 0.1 is complete for the package's declared entity domain: Wikibase
core Items and Properties, canonical JSON interchange, statements and all
their components, supported datatypes, revision/lifecycle history,
attribution and audit, search, RDF/SPARQL projection, bulk workflows,
migration, integrity, repair, policy hooks, and operational documentation.

The following are separate products or future compatibility domains rather
than missing Taproot implementation: MCP transport, agent orchestration,
authentication/authorization, UI, wiki pages, media bytes, MediaWiki APIs,
Lexeme/Form/Sense, MediaInfo, and EntitySchema entity storage.

Complete-Site assembly, resource provisioning, remote migration execution,
deployment, and production acceptance are also outside this package. The Codex
agent creating a Gnolith Site owns those responsibilities. Taproot qualifies
only its published package and supported local runtime contracts.

Adding an extension entity type changes IDs, JSON, commands, RDF, migration,
and compatibility fixtures. It must be designed and versioned as an explicit
new domain rather than accepted as unvalidated JSON.
