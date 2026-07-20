# Taproot

**The D1-native, Wikibase-compatible knowledge layer for Gnolith.**

Taproot gives a Codex Site one authoritative Wikibase-shaped Item/Property
document, immutable revisions, typed editing commands, term search, and a
deterministic RDF projection stored and queried by
[`@gnolith/diamond`](https://github.com/gnolith/diamond).

> One canonical entity document, one deterministic RDF projection, one atomic
> revision boundary.

## Status

The core is implemented but the package remains private and version `0.0.0`
until compatibility fixtures, release packaging, and the public dependency
version are finalized. Do not publish the scaffold tag.

## What it owns

- Items and Properties with Wikibase-style canonical JSON.
- Labels, descriptions, aliases, sitelinks, statements, qualifiers,
  references, ranks, and all three snak types.
- The required entity, string, external ID, URL, Commons media,
  monolingual-text, time, quantity, and coordinate datatypes.
- Atomic Q/P ID allocation, current documents, immutable revisions, lifecycle
  state, and the term-search projection in D1.
- A complete deterministic Wikibase-shaped RDF closure with truthy/best-rank,
  special-value, and full-value behavior.

It does not own authentication, MCP, agents, tasks, UI, wiki articles, media
bytes, or arbitrary SPARQL Update. Canonical entity JSON is authoritative;
there is no relational statement store.

## Setup

Taproot requires Diamond's transaction-composable quad-patch API. Initialize a
D1 binding once; the programmatic initializer creates both Diamond and Taproot
tables idempotently:

```ts
import { TaprootRepository, initializeTaproot } from '@gnolith/taproot';

await initializeTaproot(env.DB);
const knowledge = new TaprootRepository(env.DB, {
  baseIri: 'https://knowledge.example',
});

const property = await knowledge.createProperty({
  datatype: 'string',
  labels: { en: { language: 'en', value: 'occupation' } },
});
const item = await knowledge.createItem({
  labels: { en: { language: 'en', value: 'Ada Lovelace' } },
});
```

For migration-driven deployments, apply Diamond's migrations and then
[`migrations/0001_taproot.sql`](migrations/0001_taproot.sql).

## Editing

Every mutation after creation requires `expectedRevision`. Taproot loads the
current document, validates the typed change and all referenced Property
datatypes, serializes canonical JSON, rebuilds the complete old/new RDF
closures, and batches the current row, immutable revision, search terms, and
Diamond patch together. A stale guard or any SQL/RDF failure rolls the whole
batch back.

```ts
const edited = await knowledge.setLabel(item.entityId, 'fr', 'Ada Lovelace', {
  expectedRevision: item.newRevision,
  actor: 'agent:cataloguer',
  editSummary: 'add French label',
});
```

The public API includes reads/search; create/import/replace; soft delete,
restore, and redirect; all term/sitelink commands; complete statement,
qualifier, reference, and rank commands; and canonical JSON parse, validate,
and export helpers. Top-level function forms are exported alongside
`TaprootRepository`.

## SPARQL prefixes

`wikibasePrefixes(baseIri)` returns site-owned `wd:`, `wds:`, `wdv:`,
`wdref:`, `wdt:`, `p:`, `ps:`, `psv:`, `pq:`, `pqv:`, `pr:`, `prv:`, and
`wdno:` namespaces. Pass the D1 binding to Diamond's read-only SPARQL handler
to query them.

## Limits

Canonical entity JSON defaults to 1.8 MB, below D1's 2 MB bound-value limit.
Diamond enforces a 1.9 MB aggregate encoded quad-patch limit; Taproot reports
that as `QuadPatchTooLargeError`. Store PDFs, images, audio, OCR, transcripts,
and article bodies externally and represent them as knowledge Items.

See the [Codex Site example](examples/codex-site/README.md) and
[`COMPATIBILITY.md`](COMPATIBILITY.md). Run `npm run check` for the complete
local gate.

## License

MIT
