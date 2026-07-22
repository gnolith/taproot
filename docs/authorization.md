# Authorization foundation

Taproot 0.3 persists canonical Item/Property authorization and closes its
public canonical-read surface for Search Contract B03, D03, H01, and H07.
Combined-system candidate generation and hydration acceptance remain outside
this package.

Hosts create an `AuthorizationContext` only from authenticated state. It
contains installation and principal identity, active and granted workspaces,
explicit capabilities, and the installation-wide authorization revision.
Taproot never derives authority from personas, prompts, agent names,
attribution, or a generic `admin` label.

`VisibilityScopeV1` is canonical CNF: clauses are ANDed and atoms within a
clause are ORed. An empty clause list is public; an empty clause is invalid.
Normalization validates and NFC-normalizes bounded identifiers, removes
duplicates, and sorts by Unicode code unit. Intersection concatenates clauses,
so a statement restriction can only narrow its parent Item.

## Persisted policy

Migration 4 adds an immutable installation ID, one durable authorization
revision, a search generation, current and immutable per-revision entity
policy, exact per-statement restrictions, an immutable advance/admin audit, and
a projection outbox. Entity JSON, revision, audit, terms, RDF, policy, outbox,
authorization revision, and search generation commit atomically.

Whole-Item hydration uses the intersection of the Item visibility and every
statement restriction. A statement lookup uses the parent visibility
intersected with that statement's restrictions. This intentionally denies
whole-Item hydration when any statement would be hidden from the caller.

Legacy entities have no inferred visibility and fail closed. Backfill requires
a bounded, explicit full-history manifest with exact content hashes and policy
for every revision. Planning and application are audited; stale or incomplete
plans fail without partially publishing policy.

## Reads

`createAuthorizedTaproot` constructs its source from Taproot-owned persisted
tables; consumers cannot inject another policy source. Taproot verifies exact
installation and authorization revision plus visibility before hydration, then
checks again afterward. Missing, stale, deleted, or inaccessible policy yields
the same generic `AuthorizationDeniedError`.

Historical hydration first authorizes the current record, then intersects the
historical policy with current visibility. Old policy can narrow access but
cannot resurrect revoked authority. AES-GCM cursors bind operation, query,
installation, caller/grants, authorization revision, and search generation;
tampered, stale, or cross-context tokens fail generically.

## Writes and maintenance

Normal writes require an opaque `InstallationAuthorizationGuard`, a full
current context, exact `knowledge:write`, current target visibility, and the
expected canonical and authorization revisions. Policy changes additionally
require exact `knowledge:policy`. `search:admin` is orthogonal: it permits only
search readiness/backfill/maintenance and never implies corpus read, normal
write, or policy mutation.

Every successful advance stores a unique durable ID. The update and following
assertion both bind that ID, preventing an ABA race in which two batches target
the same next counters, including writes to different entities. For an ordered
cross-package batch, the guard owns the database `batch` call and wraps the
domain statements with either an exact-revision fence or an authorization
advance plus its audit and assertion. Fence and advance statements are never
returned separately, so callers cannot split the invariant across batches.
The guard exposes counters, not policy JSON, and does not create a second
revision.

Ordinary non-Knowledge domains use a separate opaque
`InstallationDomainMutationGuard` issued by the host for exactly one domain and
one capability. Task and Memory guards are therefore distinct; a caller cannot
select or widen the capability at the batch method. These guards only fence the
current shared revision and never advance authorization or search counters.
Knowledge authorization advances require both exact `knowledge:write` and
orthogonal `knowledge:policy`.

`TaprootHostWriteCapability` is limited to bootstrap, bounded legacy backfill,
maintenance, and guard issuance. The database binding, host capability, guard,
context, cursor key, and policy inputs must never come from request, MCP,
prompt, or other user-controlled data.
