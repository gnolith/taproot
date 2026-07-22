# Architecture

Taproot is the knowledge-domain layer between a D1-backed application and Diamond. The
canonical source of truth is one Wikibase-shaped JSON document per Item or
Property. Revisions are append-only snapshots. Search terms and RDF are
rebuildable projections and never become a competing statement model.

Every write performs the same transaction:

1. Load the current entity and enforce its expected revision.
2. Apply commands, validate the whole document, referenced Property
   datatypes, host validators, size limits, attribution, and lifecycle rules.
3. Serialize canonical JSON and compute its SHA-256 content/parent hashes.
4. Build the complete RDF closure and search-term projection.
5. Commit the current row, immutable revision, audit event, terms, RDF patch,
   and RDF ownership rows in one D1 batch.

RDF ownership is required because Wikibase full-value and reference nodes can
be shared. It allows an entity edit to remove an old quad only when no other
entity owns it. The table contains encoded quad keys only and is fully
rebuildable from canonical JSON.

The schema has no statement, qualifier, or reference tables. Those structures
live solely inside canonical entity JSON. Diamond's `rdf_quads` is the query
projection; `taproot_terms` is the search projection.

Taproot owns Items, Properties, their values and lifecycle, revisions,
attribution/audit history, deterministic projections, migration, integrity,
and repair. It deliberately does not own authentication, authorization, MCP,
agents, UI, wiki article bodies, media storage, or arbitrary SPARQL Update.
It also does not own Site assembly, provisioning, deployment, or acceptance.

The normal package export contains no raw canonical repository. Diamond's raw
SPARQL view covers the complete projection and is privileged maintenance/debug
infrastructure until a host builds an authorization-scoped dataset and applies
the owning canonical domain's final hydration recheck.
