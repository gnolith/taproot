# Taproot

**The portable SQLite and D1, Wikibase-compatible knowledge layer for Gnolith.**

Taproot gives a D1-backed consumer one authoritative Wikibase-shaped Item/Property
document, tamper-evident revision and attribution history, typed and batched
editing commands, term search, repairable projections, and a deterministic RDF projection stored and queried by
[`@gnolith/diamond`](https://github.com/gnolith/diamond).

> One canonical entity document, one deterministic RDF projection, one atomic
> revision boundary.

## Status

Version `0.3.0` supports Node 22 and 24 and depends exactly on Diamond `0.4.0`,
which exposes transaction-composable RDF patches, a runtime-neutral SQLite
capability, and a process-local `node:sqlite` adapter.

## What it owns

- Items and Properties with Wikibase-style canonical JSON.
- Labels, descriptions, aliases, sitelinks, statements, qualifiers,
  references, ranks, and all three snak types.
- Nonblank, explicitly authored text for every logical statement revision;
  Taproot never generates prose from properties or values.
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
- A versioned unified-search contract with deterministic serialization and pure
  authorization-preserving Statement/Item projection planning; it does not yet
  execute or persist unified search. See `docs/search-contract.md`.

It does not own authentication, MCP, agents, tasks, UI, wiki articles, media
bytes, or arbitrary SPARQL Update. Canonical entity JSON is authoritative;
there is no relational statement store.

## Setup

Taproot requires Diamond's transaction-composable quad-patch API. Initialize a
D1 binding once; the programmatic initializer creates both Diamond and Taproot
tables idempotently. First initialization requires the database's permanent
identity:

```ts
import {
  createAuthorizationCursorCodec,
  createAuthorizedTaproot,
  createItem,
  bootstrapTaprootAuthorization,
  createInstallationAuthorizationGuard,
  createTaprootHostWriteCapability,
  initializeTaproot,
  setLabel,
} from '@gnolith/taproot';

await initializeTaproot(env.DB, { baseIri: 'https://knowledge.example' });
const options = {
  baseIri: 'https://knowledge.example',
};
const writeCapability = createTaprootHostWriteCapability(
  env.DB,
  options,
  nonExtractableHmacSha256Key,
);
await bootstrapTaprootAuthorization(
  env.DB,
  options,
  writeCapability,
  'installation-1',
);
const guard = await createInstallationAuthorizationGuard(
  env.DB,
  options,
  writeCapability,
);

const item = await createItem(env.DB, options, guard, writeContext, {
  labels: { en: { language: 'en', value: 'Ada Lovelace' } },
  authorization: canonicalPolicy,
});

// The host derives context only from authenticated state. Taproot loads its
// persisted canonical policy itself. The cursor key is durable and host-held.
const knowledge = createAuthorizedTaproot(env.DB, options, readContext, {
  cursorCodec: createAuthorizationCursorCodec(nonExtractableAesGcmKey),
});
const canonical = await knowledge.getEntity(item.entityId);
```

Never accept either host key, host capability, authorization guard, context, or
policy from a request, MCP argument, prompt, or query.

Use Taproot's `planTaprootMigrations`, `applyTaprootMigrations`, and
`initializeTaproot` APIs for schema changes. The numbered SQL files document
the historical 0.1 layout and are not an operator migration interface in 0.3.
The package APIs own checksums, conservative adoption, application-level
SHA-256 backfills, and RDF reprojection.

## Editing

Every mutation after creation requires `expectedRevision`. Taproot loads the
current document, validates the typed change and all referenced Property
datatypes, serializes canonical JSON, rebuilds the complete old/new RDF
closures, and batches the current row, immutable revision, search terms, and
Diamond patch together. A stale guard or any SQL/RDF failure rolls the whole
batch back.

```ts
const edited = await setLabel(
  env.DB,
  options,
  guard,
  currentWriteContext,
  item.entityId,
  'fr',
  'Ada Lovelace',
  {
    expectedRevision: item.newRevision,
    attribution: {
      id: 'agent:cataloguer',
      kind: 'agent',
      tool: 'gnolith-mcp',
    },
    editSummary: 'add French label',
    tags: ['agent'],
    requestId: 'mcp-request-123',
    authorization: currentCanonicalPolicy,
  },
);
```

The public API exposes canonical reads only on `AuthorizedTaprootReader`.
Entity/history/list/term-search/audit/export and integrity operations require a
host-created authorization context and Taproot's persisted policy source.
Public mutation helpers require the DB/installation-bound opaque authorization
guard, a current context with exact `knowledge:write`, and canonical policy
input. Policy changes additionally require exact `knowledge:policy`. They
return only entity ID, previous/new revision, authorization/search generation,
and committed status;
they do not return canonical JSON, text, RDF counts, hashes, or audit bodies.
`TaprootRepository` and raw read helpers are intentionally absent from package
exports in the breaking 0.3 line.

The opaque guard also owns execution of ordered cross-package batches that
need an exact authorization-revision fence or advance. It does not expose raw
counter-update statements that a caller could separate from the corresponding
audit, assertion, or domain writes.
Hosts issue a distinct fence-only domain guard for each exact non-Knowledge
domain capability, such as Task or Memory writes. The capability is bound at
issuance, cannot be supplied at the call site, and an ordinary domain fence
does not advance authorization or search counters. Knowledge authorization
advances additionally require `knowledge:policy`.

Statement creation and replacement include `text` on the `Statement` itself.
Rank, qualifier, and reference mutation methods require authored text for the
new logical statement revision. `replaceEntity` and `revertEntity` require an
exact `statementTexts` map for every statement they carry forward. Reusing old
wording is allowed only when the caller deliberately supplies it again.

Set `requireAttribution: true` to reject unattributed writes. `observe` receives
isolated success/error timing records. Public write options cannot install
validators or RDF factories over canonical state and cannot vary the canonical
entity-size limit; hosts perform domain validation before invoking the write
using separately authorized input.

## SPARQL prefixes

`wikibasePrefixes(baseIri)` returns site-owned `wd:`, `wds:`, `wdv:`,
`wdref:`, `wdt:`, `p:`, `ps:`, `psv:`, `pq:`, `pqv:`, `pr:`, `prv:`, and
`wdno:` namespaces. Diamond's database-level SPARQL handler can query them, but
it sees the complete graph and is privileged host maintenance/debug
infrastructure. Do not expose it to a user, agent, MCP, or search caller.
Normal SPARQL needs an authorization-scoped dataset and final canonical policy
recheck in the owning host.

## Limits

Canonical entity JSON defaults to 1.8 MB, below D1's 2 MB bound-value limit.
Diamond enforces a 1.9 MB aggregate encoded quad-patch limit; Taproot reports
that as `QuadPatchTooLargeError`. Store PDFs, images, audio, OCR, transcripts,
and article bodies externally and represent them as knowledge Items.

Bulk imports default to create-only, can opt into `upsert`, are capped at 100
entities by default, and commit one entity atomically at a time. Authorized
bulk policies use sequential expected authorization revisions; Taproot carries
each successful advance into the next entity's context. Multi-command edits
apply up to 100 commands in one revision. All list limits are capped at 500.

See the [local D1 and Diamond interoperability example](examples/d1-diamond-interop/README.md),
[`COMPATIBILITY.md`](COMPATIBILITY.md), and the architecture, API, operations,
and release documents under `docs/`. Run `npm run check` for the complete local
package release-quality gate. These checks do not assemble, provision, deploy,
or accept a complete Gnolith Site; the Codex agent creating a Site owns those
responsibilities.

## License

MIT
