# Security

Report vulnerabilities privately through GitHub Security Advisories. Do not
open a public issue for an undisclosed vulnerability.

The latest published minor line receives security fixes. Older pre-1.0 minor
lines are unsupported unless a security advisory explicitly says otherwise.

Include the affected API, a minimal D1/entity reproduction, impact on
canonical history or RDF query results, and whether untrusted JSON or SPARQL
input is required. Do not include production data or credentials.

Taproot records attribution claims but does not authenticate identities or
persist principals, memberships, or sessions. It does persist canonical entity
authorization policy and requires a host-created current context plus an
opaque DB-bound guard for normal writes. Canonical JSON, authorization policy,
revision/audit immutability, size limits, optimistic revision/authorization
guards, and read-only Diamond SPARQL are security boundaries; rebuildable
projection content is not authoritative.

The threat model and host responsibilities are documented in
`docs/threat-model.md`.

Package security checks do not qualify a deployed Site. The Codex agent creating
a Site owns its authentication, routing, provisioning, deployment, and
production acceptance.
