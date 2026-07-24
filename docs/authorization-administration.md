# Authorization administration

`prepareAuthorizationAdministrationV1`,
`registerAuthorizationAdministrationOwnerV1`, and
`commitAuthorizationAdministrationV1` form a sealed, versioned owner
protocol. A caller must present a live `search:admin` capability and the exact
installation authorization revision. The Workshop owner participant is bound
to the same database connection and contributes prepared credential/OAuth
mapping statements without exposing secrets to Taproot.

Accepted commands put principals and workspaces, grant or revoke a capability,
and set Entity, Resource, or Annotation visibility. Visibility changes create
new canonical revisions so historical authorization remains immutable and
candidate/hydration checks retain their current-plus-historical
non-disclosure fence. Every accepted command atomically records an immutable
receipt and advances authorization and search state. Exact idempotent retries
return the durable receipt; conflicting keys and stale revisions fail closed.

`set-entity-visibility` targets the existing canonical Entity named by
`entityId`; `expectedRevision` is that Entity's current canonical revision,
not the installation authorization revision. A successful update may narrow
or widen visibility under the sealed administration capability and creates
exactly one new Entity revision. A stale target revision raises
`RevisionConflictError`; an unknown Entity raises `EntityNotFoundError`.

Visibility uses canonical conjunctive normal form (CNF): the outer `clauses`
array is an AND, while the atoms inside each clause are alternatives joined by
OR. To make an Entity visible to either its owner or a reader, put both
principal atoms in one clause:

```json
{
  "version": 1,
  "clauses": [
    [
      { "kind": "principal", "principalId": "owner" },
      { "kind": "principal", "principalId": "reader" }
    ]
  ]
}
```

Two singleton clauses instead mean `owner AND reader`. Because one request
principal cannot have both identities, administration rejects that policy
when it would exclude the updating caller. It is never silently rewritten or
stored as an OR.
