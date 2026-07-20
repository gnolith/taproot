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
| Operations/release   | Architecture/API/operations/scope/security/testing docs, Node 22/24 CI, packed consumer, license and release gates           |

## Reproduction

```sh
npm ci
npm run check
```

Diamond `0.3.2` or later supplies the registry-published composable patch API.
The packed-consumer gate installs Taproot and Diamond without repository
siblings or local paths and exercises a fresh Workerd D1 database.
