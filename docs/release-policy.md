# Release and support policy

Taproot uses Semantic Versioning. Before 1.0, minor versions may deliberately
change APIs or RDF mappings, but every such change must be documented and
migratable. Patch releases preserve the documented public API and stored model.

Releases are created only from annotated semantic-version tags whose commits
belong to `main`. The protected `release` environment accepts only `v*.*.*`
tags. GitHub Actions verifies the version and tag, runs the full quality gate,
inspects the packed artifact, publishes to npm through OIDC trusted publishing,
and attaches the tarball, SBOM, checksums, and build attestation to a GitHub
Release.

The current minor line receives fixes. Security support follows `SECURITY.md`.
Deprecations are announced in the changelog before removal whenever a safe
migration path exists.
