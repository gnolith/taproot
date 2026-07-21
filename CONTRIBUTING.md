# Contributing

Use an issue to establish scope before substantial work. Fork the repository,
create a focused branch, and submit a pull request describing behavior,
compatibility, security, and migration effects.

Install Node 22 or 24 and run `npm ci` followed by `npm run check`. Important
behavior changes need unit tests and, when D1 transactions or projections are
involved, Workerd/D1 integration coverage. Compatibility claims require named
fixtures or behavioral tests. Do not lower coverage or security gates merely to
make a change pass.

Workerd/D1 coverage is a local package-runtime check. It does not qualify a
deployed Gnolith Site; that responsibility belongs to the Site-creating Codex
agent.

By contributing, you agree that your contribution is licensed under MIT and
that project interactions follow `CODE_OF_CONDUCT.md`.
