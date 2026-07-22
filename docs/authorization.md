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

## Compatibility boundary

The pre-search `TaprootRepository` and its top-level helpers remain exported in
0.2 for trusted migration, repair, import, and package compatibility. They are
not an authorization-enforcing application/search boundary and do not satisfy
the Search Contract. Hosts must not expose them to request, agent, MCP, or
search callers. Removing or capability-gating that legacy surface is tracked
in [Taproot issue 24](https://github.com/gnolith/taproot/issues/24) and is
required before the combined search release can claim that every public
canonical read path is authorization-enforcing.

Taproot deliberately does not persist principals, memberships, or sessions.
The owning host/domain supplies canonical authorization records through
`EntityAuthorizationSource`; later lexical candidate selection must apply the
same scope before loading text and use `AuthorizedTaprootReader` for hydration.
