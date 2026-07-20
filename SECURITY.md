# Security

Report vulnerabilities privately through GitHub Security Advisories. Do not
open a public issue for an undisclosed vulnerability.

The latest published minor line receives security fixes. Older pre-1.0 minor
lines are unsupported unless a security advisory explicitly says otherwise.

Include the affected API, a minimal D1/entity reproduction, impact on
canonical history or RDF query results, and whether untrusted JSON or SPARQL
input is required. Do not include production data or credentials.

Taproot records attribution claims but does not authenticate identities or
authorize writes. Hosts must keep mutation routes trusted. Canonical JSON,
revision/audit immutability, size limits, optimistic revision guards, and
read-only Diamond SPARQL are security boundaries; projection tables are not.

The threat model and host responsibilities are documented in
`docs/threat-model.md`.
