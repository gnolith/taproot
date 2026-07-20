# Taproot

**Wikibase-style knowledge layer for Gnolith.**

Taproot will provide entity, statement, qualifier, reference, rank, revision,
and truthy-projection behavior above Gnolith storage foundations such as
[`@gnolith/diamond`](https://github.com/gnolith/diamond).

## Status

This repository is a private, non-publishable scaffold. It deliberately exposes
no public API yet. Exact Wikibase compatibility will only be claimed for a
named interoperability target backed by differential fixtures.

## Intended boundaries

- Own the knowledge-domain model and guarded lifecycle commands.
- Depend on public storage interfaces instead of D1 implementation details.
- Keep authentication, hosted agent orchestration, and MCP transport out of
  this package.

## Development

```sh
npm ci
npm run check
```

## License

MIT
