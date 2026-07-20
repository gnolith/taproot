# Core completion audit

This audit maps the coding packet to reproducible repository evidence. It
covers the core package, not npm publication, authentication, audit policy,
agent transport, or other stated non-goals.

| Requirement                                                                      | Evidence                                                                                                                                    | Status                                                                                           |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Build as `@gnolith/taproot`                                                      | `package.json`, `npm run build`, and `npm pack --dry-run`                                                                                   | Proven locally; package intentionally remains private/version `0.0.0`                            |
| Work in a Codex Site using D1                                                    | `examples/codex-site`, programmatic/migration setup, and nine Miniflare Workerd/D1 scenarios                                                | Proven locally                                                                                   |
| Depend on Diamond                                                                | Package dependency plus `prepareQuadPatch()` integration in `repository.ts`                                                                 | Proven against the adjacent Diamond change; registry release ordering remains before publication |
| Canonical JSON and immutable revisions                                           | Canonical fixture/round-trip tests and revision history assertions                                                                          | Proven                                                                                           |
| Atomic JSON, revision, terms, and RDF                                            | Caller-owned D1 batch, revision/namespace assertions, injected RDF-trigger rollback test                                                    | Proven in Workerd D1                                                                             |
| Items, Properties, statements, qualifiers, references, ranks, and all snak types | Domain types, validator, command lifecycle tests, rank/special-value RDF tests                                                              | Proven                                                                                           |
| Required datatypes and full values                                               | Every-datatype mapper test plus time/quantity/coordinate predicate assertions                                                               | Proven                                                                                           |
| Wikidata-style SPARQL with custom prefixes                                       | `wikibasePrefixes()` and direct/full-statement Diamond SPARQL tests (`p`, `ps`, `pqv`, `pr`)                                                | Proven                                                                                           |
| Stale competing edits cannot both commit                                         | Concurrent same-revision Workerd test                                                                                                       | Proven                                                                                           |
| JSON and RDF cannot diverge after failures                                       | Injected RDF failure verifies current JSON, revision count, and search rollback; Diamond composition verifies adjacent application rollback | Proven                                                                                           |
| No third authoritative statement store                                           | Schema contains only canonical entity JSON, revisions, counters, terms, metadata, and internal assertions; RDF remains a projection         | Proven structurally                                                                              |

## Detailed packet coverage

- D1 schema: all four specified tables, metadata, internal transaction
  assertions, lookup indexes, idempotent initialization, inspection, and a
  migration are present. FTS5 remains intentionally optional and unused.
- JSON: Item/Property shapes, language terms, aliases, sitelinks, claims,
  statement/reference ordering, IDs/hashes, ranks, snak types, full datavalues,
  deterministic nested field order, import/export, size checks, and typed
  validation errors are covered.
- RDF: site namespaces, entity/property declarations, statement paths,
  truthy/best-rank rules, qualifiers, grouped references, full values,
  collision-free deterministic full/somevalue IRIs, novalue classes, and the
  revision guard triple are implemented.
- Writes: creation/import, replacement, soft delete/restore/redirect, every
  term/sitelink command, and statement/qualifier/reference/rank lifecycles use
  the same full-closure replacement path.
- Constraints: concurrent Q/P allocation, trusted explicit IDs, Property
  existence/datatype checks, datatype immutability after use, database base-IRI
  binding, entity/patch limits, and stale revisions have behavioral tests.
- Interoperability: the named JSON/RDF fixture and intentional differences are
  documented in `COMPATIBILITY.md`.

## Reproduction

```sh
npm ci
npm run check
npm pack --dry-run
```

Diamond's own full gate must also pass for its composable-patch prerequisite.
The current local Diamond branch passes all 116 tests, Workerd checks, build,
packed-consumer smoke test, license gate, and readiness audit.

## Publication gate

Taproot's development dependency points at the adjacent Diamond checkout so
both unreleased changes can be tested atomically. Before npm publication,
merge and release Diamond's composable patch API, replace the local dependency
with that registry version, regenerate the lockfile, rerun this audit, and only
then remove Taproot's private/version safeguard.
