# Unified search contract V1

Taproot exposes a versioned, runtime-neutral contract, projection planning,
and an executable authorized search service. V1 recognizes exactly these canonical
kinds, in this order:

`statement`, `item`, `task`, `memory`, `prompt`, `resource`, `annotation`.

Omitting `kinds` searches all seven. Taproot owns native Statement, Item,
Resource, and Annotation production. Workshop supplies Task, Memory, and Prompt
through the migration-0007 host-sealed data-only producer boundary. The legacy
pure Task/Memory/Prompt projector placeholders still fail explicitly because
cross-domain production requires an assembly-issued producer guard.

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

V1 does not accept source IDs or Item IDs as filters.

Strict normalizers also define typed references, match offsets without match
text, result pages, a bounded public error vocabulary, source events, and
cursor bindings. A cursor binding covers the normalized query/kinds/filters,
installation, normalized principal/workspace/capability context,
authorization revision, and search generation. `createAuthorizedSearchServiceV1`
issues opaque bound cursors and rejects stale, tampered, or cross-query reuse.

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

## Runtime boundary

Migration 0008 adds canonical Resource/Annotation storage and durable semantic
configuration, generation, work, usage, exclusion, and vector state. The public
search operation performs authorization before exposure, deterministic lexical
ranking and snippets, optional ready-generation semantic fusion, and a second
current-policy/revision check during hydration. Migrations 0005 through 0008
persist source events and the guarded materialization lifecycle documented in
[search-source-events.md](search-source-events.md) and
[search-materialization.md](search-materialization.md). Existing
`searchEntities`, `SearchOptions`, `SearchResult`, RDF mapping, and SPARQL
behavior remain separate and unchanged. No hosted Site is assembled,
provisioned, deployed, or accepted by this package.
