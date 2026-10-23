# Contributing

Thanks for looking. The most useful contributions right now:

1. **Reports from real chargers and networks.** If you've tried the bridge with a real charger or a network's CSIP-AUS setup, tell us what happened, good or bad, using the [charger/network issue template](.github/ISSUE_TEMPLATE/charger-or-network-problem.md).
2. **Small, focused pull requests** for bugs or the gaps listed under "What doesn't work yet" in the [README](README.md).

## Before you open a pull request

```bash
npm ci
npm run typecheck
npm run demo
```

Then run the other demos in [docs/testing.md](docs/testing.md), or let CI run them. CI must pass.

- Keep changes small and explain *why* in the PR description.
- A new feature should come with a demo or check that exits non-zero on failure (see "Adding a demo" in [docs/testing.md](docs/testing.md)).
- Never commit certificates, private keys or real network credentials. `.gitignore` blocks the common file types, but check your diff.
- For anything large, open an issue first so we can agree on the approach.

## Security problems

If you find something that could let someone control chargers or a site's power without permission, please don't open a public issue. Contact the maintainer privately first. *(TODO: add a security contact before the public release.)*

## Licence

By contributing you agree that your contribution is licensed under [Apache-2.0](LICENSE), the same as the project.
