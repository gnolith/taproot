# Threat model

## Protected assets

Taproot protects canonical entity state, immutable revision and audit history,
optimistic-write ordering, search projections, RDF query projections, and the
association between an edit and its claimed attribution metadata.

## Trust boundaries

Taproot assumes its consumer supplies a SQLite/D1 binding and absolute base IRI.
Hosts create `AuthorizationContext` values only from authenticated state and
supply current canonical policies to `AuthorizedTaprootReader`; Taproot checks
them before and after hydration. The normal package export has no raw canonical
repository. Callers reaching mutations must already have write authority from
the host. Every public mutation requires a runtime-branded capability bound to
the exact database object and normalized installation base IRI; invalid
capabilities fail before database work or observers. Mutation receipts do not
disclose canonical bodies. Host assembly withholds the database binding,
capability, and host keys from request, user, agent, and MCP code. Because code
holding the database binding can mint a capability in the same JavaScript realm,
this is a host-process authority boundary rather than per-entity authorization.
Attribution is a stored claim, not proof of identity. Diamond executes
the RDF patch prepared by Taproot and exposes read-only SPARQL querying; hosts
must not give untrusted callers an independent write path to Taproot or Diamond
tables.

## Threats and controls

- Lost updates are blocked by expected-revision guards inside the same D1 batch
  as all canonical and projected writes.
- Partial writes are blocked by D1 batch atomicity; injected Workerd failures
  verify rollback across Taproot and Diamond.
- History tampering is deterred and detected by immutable-table triggers,
  SHA-256 content/parent chains, schema inspection, and integrity APIs.
- Resource exhaustion is bounded by entity, command, page, bulk, redirect, and
  RDF patch limits. Request-size, authentication, and network rate limits are
  outside the package boundary.
- RDF projection confusion is constrained by strict entity validation,
  deterministic mapping, site-owned namespaces, and per-entity quad ownership.
- Application/search canonical reads fail closed on absent policy,
  cross-installation identity, stale authorization revision, policy changes
  during hydration, and malformed CNF visibility. Denials have a generic body.
- Search administration requires the exact `search:admin` capability; personas
  and generic administrator labels do not imply it.
- Page cursors require a non-extractable host AES-GCM key, use fixed-size
  plaintext padding, and bind caller, grants, operation, query/filter, auth
  revision, and canonical revision/audit generation.
- Dependency and release compromise is reduced through locked installs, pinned
  GitHub Actions, dependency review, CodeQL, secret scanning, license checks,
  OIDC npm publishing, provenance, SBOMs, checksums, and attestations.

## Out of scope

Taproot does not provide authentication, principal/workspace persistence, agent/MCP isolation,
network rate limiting, D1 backup custody, UI sanitization, or arbitrary SPARQL
Update. A compromised host with direct D1 access can bypass library controls;
restore from a trusted backup and verify audit chains after such an incident.

Taproot's local Workerd tests validate its package controls under the supported
D1 contract. They do not qualify a deployed host. The Codex agent creating a
Site owns assembly, provisioning, route and security wiring, deployment, backup
policy, and production acceptance.

Diamond's database-level SPARQL handler sees Taproot's complete RDF projection
and is therefore privileged host maintenance/debug infrastructure, not a
normal user, agent, MCP, or search endpoint. Workshop must construct an
authorization-scoped dataset (with a final canonical recheck) before exposing
SPARQL results. Possession of the SQLite/D1 binding itself remains privileged:
a compromised host can query tables outside any package API.
