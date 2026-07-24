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

Every CI quality run also executes the deterministic
`release:candidate` generator and uploads a commit-named candidate artifact.
The bundle contains the exact npm tarball, a runtime-only CycloneDX JSON SBOM,
checksum-bound provenance, and `SHA256SUMS`. The SBOM and provenance both bind
the package SHA-256 to the source commit and tree. `release:check` produces the
bundle twice and requires byte-identical inventories before accepting it.
Maintainer handoffs regenerate this bundle from the merged `main` commit into
the stable candidate evidence directory; pre-merge or working-tree hashes are
never represented as final release coordinates.

Until Diamond 0.5.0 is registry-published, hosted workflows check out its exact
pinned source commit, build the local dependency tarball before `npm ci`, and
verify it against the SHA-512 already recorded in `package-lock.json`. The
public Taproot manifest remains registry-only; no local file dependency is
exposed to package consumers.

A Taproot release qualifies the published package and its supported local
runtime contracts. It does not assemble, provision, deploy, or accept a complete
Gnolith Site; the Codex agent creating a Site owns those responsibilities.

The current minor line receives fixes. Security support follows `SECURITY.md`.
Deprecations are announced in the changelog before removal whenever a safe
migration path exists.
