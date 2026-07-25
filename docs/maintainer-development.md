# Maintainer development

Owner-authorized maintenance. Public bug reports are welcome; external pull
requests and feature requests are not accepted — see the
[participation policy](https://github.com/sagmans/pi-stash/blob/main/CONTRIBUTING.md).
For behavior and install, see [`README.md`](../README.md).

Requires Node.js >= 22.19.0 (tests use `node --experimental-transform-types`).

```bash
npm ci --ignore-scripts
npm run check       # biome lint + format
npm run check:fix   # apply biome fixes
npm run typecheck
npm run test
npm run verify       # deterministic offline checks
npm run audit        # network-dependent high-severity dependency gate
npm run verify:ci    # complete maintainer and CI gate
npm run smoke:herdr  # disposable real-TUI smoke; Herdr maintainers only
npm pack --dry-run   # inspect exact public package contents
```

`npm run verify:ci` is the authoritative maintainer gate and runs in every CI
matrix leg: Ubuntu and macOS on Node 22.19.0 and 24. `npm run verify` is its
deterministic offline subset. A tagged release builds one npm artifact, verifies
that exact artifact in all four legs, and publishes it only after the aggregate
matrix succeeds. Failed, cancelled, skipped, or timed-out legs block publication;
inspect the package job and every expanded matrix leg before rerunning the
workflow. The Herdr smoke remains outside CI; see
[`docs/maintainer-smoke.md`](https://github.com/sagmans/pi-stash/blob/main/docs/maintainer-smoke.md).

The audit currently reports moderate `GHSA-j3f2-48v5-ccww` in the dev-only
`protobufjs` copy nested under pi; reassess it with every pi dependency update.

Two Biome rules are disabled in `biome.json` to keep the development template
aligned with pi-history. pi-stash does not currently rely on either exception;
remove an override only through a coordinated template update.

Git hooks via Husky: pre-commit runs `npm run check`, pre-push runs
`npm run typecheck && npm test`. Hooks are dev-only: there is deliberately no
`prepare` script, because pi runs `npm install` inside its package clones and
hooks must never install on user machines. Maintainers opt in once after
cloning:

```bash
npx husky
```
