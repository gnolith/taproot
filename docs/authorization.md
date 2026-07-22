# Authorization foundation

This foundation supplies primitives needed toward Search Contract **B03, D03,
H01, and H07**. None of those contract IDs is complete or evidenced by this PR
alone: candidate prefiltering, cursor binding, canonical domain persistence,
all public read boundaries, and combined-system acceptance remain outstanding.

Hosts create an `AuthorizationContext` from authenticated state. All fields are
required: installation and principal identity, active and authorized workspace
identity, explicit capabilities, and the installation-wide authorization
revision. Taproot validates and normalizes the context; it never derives
authority from a persona, prompt, agent name, attribution record, or generic
`admin` label.

`VisibilityScopeV1` is a canonical CNF value. Its clauses are ANDed and atoms
inside a clause are ORed. The empty clause list is public. An empty individual
clause is invalid. Normalization validates all fields, NFC-normalizes bounded
identifiers, removes duplicates and true/public clauses, and sorts by Unicode
code unit. Serialization and SHA-256 fingerprints are therefore portable.
Intersecting scopes concatenates their clauses before normalization, so a
Resource annotation can further restrict its target without losing either
policy.

`AuthorizedTaprootReader` is the application/search canonical hydration
boundary. Its context and `EntityAuthorizationSource` are mandatory. The
source must return current installation state and canonical visibility state;
missing state fails closed. Taproot checks installation identity, the exact
installation authorization revision, and visibility before hydration, then
loads and checks again. Policy changes during hydration fail with the same
generic `AuthorizationDeniedError` as every other denial.

Historical hydration first authorizes the current canonical record. A missing,
deleted, or currently inaccessible source denies access even when its requested
historical revision was public. The historical revision policy is then
intersected with current visibility, so old policy can only further restrict
access and can never resurrect revoked authority.

`search:admin` is the only search-administration capability recognized by
`requireSearchAdministration`. `admin`, `administrator`, `assistant`, and
other personas do not imply it.

## Public boundary in 0.3

`TaprootRepository`, `createTaproot`, and the old raw read helpers are absent
from the package export. Normal consumers cannot hydrate canonical entities,
history, lists, term matches, audit payloads, exports, or integrity diagnostics
without `AuthorizedTaprootReader`. Public writes return minimal receipts and
reject validator/RDF-factory callbacks and configurable entity-size probes,
preventing writes from becoming an implicit read channel. Package migrations
and schema inspection remain host operations but do not return canonical
content.

Authorized page cursors are AES-GCM encrypted/authenticated with a branded
codec created from a durable, non-extractable host key. Taproot binds each
cursor to operation, normalized query/filter, installation, principal,
workspace grants, capabilities, authorization revision, and current canonical
revision generation. A cursor is not usable after mutation, revocation, with
another query, or by another context. Failures are generic. Candidates are
selected as identifiers, authorized, then hydrated; denied candidates are
skipped while bounded scans continue to fill an authorized page.

This surface closure is not canonical policy persistence. Until Taproot's
follow-up persistence issue lands, hosts have no package-owned authoritative
policy store and the Search Contract IDs named above remain incomplete. Legacy
canonical rows must fail closed; they must never be interpreted as public.

Taproot deliberately does not persist principals, memberships, or sessions.
The owning host/domain supplies canonical authorization records through
`EntityAuthorizationSource`; later lexical candidate selection must apply the
same scope before loading text and use `AuthorizedTaprootReader` for hydration.
