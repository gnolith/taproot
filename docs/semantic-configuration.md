# Semantic configuration

`SemanticConfigurationV1` is the durable declarative contract for semantic
search. Providers are `ollama-compatible` or `openai-compatible` identities
with an exact full POST endpoint, model, dimensions, metric, credential
selector, private endpoint approval, and an `error` redirect policy. Taproot
uses that endpoint unchanged: callers provide `/api/embed` or the compatible
`/v1/embeddings` route, and Taproot never appends a provider path. Vector storage is either
local SQLite or a Qdrant identity with endpoint, collection, selector, private
approval, and the same redirect policy.

`SemanticSearchAdminV1.configure` requires an expected configuration revision
and idempotency key. Taproot persists the canonical fingerprint, revision, and
selector names, but never resolved credential values. Changing a provider
model, dimensions, or vector identity advances the vector generation and
clears readiness until the new generation is built. Lexical search remains
available while semantic validation or rebuilding is incomplete.
Declarative provider and vector bindings are reconstructed from persisted
selector identities after restart; resolved secrets remain runtime-only.

`status()` exposes the selected configuration's durable `state`, `revision`,
`fingerprint`, and `ready` projection together with boolean `configured` and
the total `configurationCount`. `failureCode` is a bounded non-secret code such
as `validation-failure`, `batch-failure`, or `runtime-failure`; it never
contains provider response bodies, URLs, credentials, or exception text. An
offline provider may remain configured but not ready; lexical search still
remains available.
