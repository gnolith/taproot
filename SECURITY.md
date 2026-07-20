# Security

Report vulnerabilities privately through GitHub Security Advisories. Do not
open a public issue for an undisclosed vulnerability.

Until the first registry release, only the current `main` branch and active
release-candidate PR are eligible for fixes. After release, the latest minor
line will receive security fixes.

Include the affected API, a minimal D1/entity reproduction, impact on
canonical history or RDF query results, and whether untrusted JSON or SPARQL
input is required. Do not include production data or credentials.

Taproot records attribution claims but does not authenticate identities or
authorize writes. Hosts must keep mutation routes trusted. Canonical JSON,
revision/audit immutability, size limits, optimistic revision guards, and
read-only Diamond SPARQL are security boundaries; projection tables are not.
