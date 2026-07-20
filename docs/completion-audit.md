# Completion audit

This audit covers the complete Taproot package boundary defined in
`product-scope.md`, not merely CRUD.

| Capability           | Evidence                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Canonical model      | Item/Property types, strict validator, canonical serializer, statement/reference builders, JSON fixture                      |
| Complete edits       | Typed individual commands, `applyCommands`, optimistic revisions, all term/sitelink/statement/qualifier/reference/rank paths |
| Lifecycle            | Soft delete, restore, same-type acyclic redirects, bounded resolution, lifecycle snapshots in every revision/event           |
| Attribution/audit    | Structured actors, legacy normalization, summaries, tags, request IDs, immutable events/revisions, SHA-256 parent chains     |
| D1 atomicity         | One batch for current JSON, revision, audit, terms, RDF, and ownership; rollback and competing-edit Workerd tests            |
| RDF/SPARQL           | Wikibase paths, truthy/best rank, all snak types, full values, standard statement/provenance types, mapping v2 fixtures      |
| Shared RDF safety    | Per-entity quad ownership and behavioral regression covering a shared full-value node during another entity's edit           |
| Search/read scale    | Entity/revision/audit keyset cursors, bounded search cursor, configured page limits                                          |
| Bulk/agent workflows | Multi-command single revision, bounded create/upsert import with indexed errors, NDJSON export, request correlation          |
| Migration            | Versioned SQL, programmatic v1 hash/audit backfill, resumable v1-to-v2 RDF reprojection and ownership creation               |
| Integrity/repair     | Schema inspection, audit-chain verification, JSON/revision/term/RDF comparison, cursor scan, audited reprojection repair     |
| Extension points     | Required attribution, async host validators, isolated observations, injected clock and IDs                                   |
| Operations/release   | Architecture/API/operations/scope docs, changelog, Node 22/24 CI, Dependabot, pack gate, private dependency release guard    |

## Reproduction

```sh
npm ci
npm run check
npm run pack:check
```

The Diamond composable-patch branch must pass its own full gate. Taproot stays
private until that dependency is released to npm and the local dependency is
replaced with its registry version. That is the sole package-publication gate;
it is not an omitted Taproot feature.
