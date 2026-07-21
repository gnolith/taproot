# Taproot

**The D1-native, Wikibase-compatible knowledge layer for Gnolith.**

Taproot gives a D1-backed consumer one authoritative Wikibase-shaped Item/Property
document, tamper-evident revision and attribution history, typed and batched
editing commands, term search, repairable projections, and a deterministic RDF projection stored and queried by
[`@gnolith/diamond`](https://github.com/gnolith/diamond).

> One canonical entity document, one deterministic RDF projection, one atomic
> revision boundary.

## Status

Version `0.1.0` is the first public release. Taproot supports Node 22 and 24 and
depends on the registry release of Diamond that exposes transaction-composable
quad patches.

## What it owns

- Items and Properties with Wikibase-style canonical JSON.
- Labels, descriptions, aliases, sitelinks, statements, qualifiers,
  references, ranks, and all three snak types.
- Item, Property, Lexeme, Form, Sense, and EntitySchema links; string,
  external ID, URL, Commons media, monolingual text, time,
  quantity, coordinate, math, musical notation, geo-shape, and tabular-data
  datatypes.
- Atomic Q/P ID allocation, current documents, immutable revisions, lifecycle
  history, structured human/agent/import/system attribution, tags, request
  correlation, audit events, and the term-search projection in D1.
- A complete deterministic Wikibase-shaped RDF closure with truthy/best-rank,
  special-value, and full-value behavior.
- Cursor reads, bounded import/upsert and NDJSON export, multi-command edits,
  redirect resolution, integrity verification, deterministic repair, schema/RDF
  migrations, validation policies, and write observations.

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

Consumers applying migrations separately should apply Diamond's migrations and
the numbered Taproot SQL files, then call `initializeTaproot()`. The initializer performs
the application-level SHA-256 backfill that SQLite SQL alone cannot perform,
reprojects older RDF mapping versions, installs immutability triggers, and is
safe to call repeatedly.

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
  attribution: {
    id: 'agent:cataloguer',
    kind: 'agent',
    tool: 'gnolith-mcp',
  },
  editSummary: 'add French label',
  tags: ['agent'],
  requestId: 'mcp-request-123',
});
```

The public API includes reads/search; create/import/replace; soft delete,
restore, and redirect; all term/sitelink commands; complete statement,
qualifier, reference, and rank commands; audit/history and integrity reads;
bulk workflows; and canonical JSON parse, validate, create, and export helpers. Top-level function forms are exported alongside
`TaprootRepository`.

Set `requireAttribution: true` to reject unattributed writes. `validators`
provide host policy checks without coupling Taproot to authentication, and
`observe` receives isolated success/error timing records for committed writes.

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

Bulk imports default to create-only, can opt into `upsert`, are capped at 100
entities by default, and commit one entity atomically at a time. Multi-command
edits apply up to 100 commands in one revision. All list limits are capped at 500.

See the [local D1 and Diamond interoperability example](examples/d1-diamond-interop/README.md),
[`COMPATIBILITY.md`](COMPATIBILITY.md), and the architecture, API, operations,
and release documents under `docs/`. Run `npm run check` for the complete local
package release-quality gate. These checks do not assemble, provision, deploy,
or accept a complete Gnolith Site; the Codex agent creating a Site owns those
responsibilities.

## License

MIT
