# Unified search contract V1

Taproot exposes a versioned, runtime-neutral contract and pure projection
planning for future unified search. V1 recognizes exactly these canonical
kinds, in this order:

`statement`, `item`, `task`, `memory`, `prompt`, `resource`, `annotation`.

Omitting `kinds` normalizes to all seven for contract negotiation only. It does
not claim that all seven projectors or an executable search service exist.
Taproot currently implements pure projection planning only for `statement` and
`item`. Task, Memory, Prompt, Resource, and Annotation projector entry points
fail with `UnsupportedSearchProjectionError`; they never return an empty
successful plan.

## Request and response boundary

`normalizeUnifiedSearchRequestV1` rejects unknown keys and kinds, blank or
oversized queries, invalid limits, invalid collection values, and kind-filter
blocks for kinds not selected by the request. The V1 filter vocabulary is
closed:

- common: `languages`, exact opaque `sourceRevisions`;
- Statement: `predicateIds`;
- Item: `typeIds`;
- Task: `statuses`;
- Resource: `mediaTypes`;
- Memory, Prompt, and Annotation: common filters only.

Task and Resource filters are recognized structurally even though those
projectors are deferred. This is vocabulary stability, not implementation
support. V1 does not accept source IDs or Item IDs as filters.

Strict normalizers also define typed references, match offsets without match
text, result pages, a bounded public error vocabulary, source events, and
cursor bindings. A cursor binding covers the normalized query/kinds/filters,
installation, normalized principal/workspace/capability context,
authorization revision, and search generation. Taproot does not issue a
unified-search cursor in this slice.

## Canonical projection values

`canonicalSearchBytesV1` uses NFC strings, Unicode code-unit key order,
canonical JSON-compatible primitives, and explicit `null`. SHA-256 hashes and
document/chunk/plan IDs are derived from those bytes with a versioned namespace.
Golden tests pin Unicode, `null`, object-order, hash, and ID vectors.

Projection authorization is a process-local opaque envelope. Creating one
requires an opaque authority derived from Taproot's concrete persisted policy
source. Request, MCP, prompt, stored content, and JSON values cannot construct
that authority or a trusted envelope. The future assembly must populate the
envelope from current canonical policy; it must never accept policy from the
search request.

## Pure projectors

The Statement projector emits one authored logical Statement text. It does not
emit or group RDF quads and never generates prose from structured values.

The Item projector emits labels, aliases, descriptions, P31 Item type IDs, and
every current authored Statement text exactly once. Statement authorization
must exactly cover current Statement IDs. Effective Statement scope is always
the intersection of Item and Statement scope, so a hostile Statement envelope
cannot widen its Item. Mixed scopes are either partitioned into separate
documents or rejected explicitly, according to caller-selected policy.

Documents split into UTF-8-bounded chunks without omission or reordering.
Every chunk traces its source fields and document offsets and declares
`canonical: false`; canonical domain content remains the Item or Statement.
The deterministic newline between adjacent fields is attributed to the
following field's trace, so even a separator-only chunk retains a source.
Crossing the explicit chunk-count bound fails instead of silently dropping
text.

## Explicit nonclaims

This contract does not implement search execution, candidate retrieval,
ranking, snippets, cursor issuance, hydration, persistence, a migration,
projection queues/outboxes, health, rebuild, provider adapters, or complete
system acceptance. Migration number `0005` is reserved for a later persistence
slice and is not present here. Existing `searchEntities`, `SearchOptions`,
`SearchResult`, RDF mapping, and SPARQL behavior remain separate and unchanged.
No hosted Site is assembled, provisioned, deployed, or accepted by this
package.
