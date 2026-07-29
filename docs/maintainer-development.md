# Maintainer development

Owner-authorized maintenance. Public bug reports are welcome; external pull
requests and feature requests are not accepted — see the
[participation policy](../CONTRIBUTING.md).
For behavior and install, see [`README.md`](../README.md).

Requires Node.js >= 22.19.0. Tests use Node's native type stripping, and
TypeScript's `erasableSyntaxOnly` check prevents syntax that would require an
experimental transform.

```bash
npm ci --ignore-scripts
npm run check       # biome lint + format
npm run check:fix   # apply biome fixes
npm run typecheck
npm run test
npm run verify       # deterministic offline checks
npm run audit        # network-dependent moderate-and-higher dependency gate
npm run verify:ci    # complete maintainer and CI gate
npm run smoke:herdr  # packaged two-launch real-TUI smoke; Herdr maintainers only
npm run smoke:herdr -- /path/to/package.tgz  # smoke an exact CI artifact
npm pack --dry-run   # inspect exact public package contents
```

`npm run verify:ci` is the authoritative maintainer gate and runs in every CI
matrix leg: Ubuntu and macOS on Node 22.19.0 and 24. `npm run verify` is its
deterministic offline subset. A tagged release builds one npm artifact, verifies
that exact artifact in all four legs, and publishes it only after the aggregate
matrix succeeds. Failed, cancelled, skipped, or timed-out legs block publication;
inspect the package job and every expanded matrix leg before rerunning the
workflow. The Herdr smoke remains outside hosted CI; download its
`npm-package` artifact and pass the `.tgz` to the smoke on a Herdr maintainer
host for exact-artifact evidence. See
[maintainer smoke test](maintainer-smoke.md).

Do not hide audit output or weaken its severity threshold. Keep the development
graph limited to extension runtime imports; any upstream finding requires a
verified fixed dependency pin or the release owner's narrow SHA-bound waiver
under the release policy.

Two Biome rules are disabled in `biome.json` to keep the development template
aligned with pi-history. pi-stash does not currently rely on either exception;
remove an override only through a coordinated template update.

Keep the user-level `core.hooksPath` authoritative; do not override it per clone.
The tracked `.husky/pre-commit` and `.husky/pre-push` scripts are optional targets
for global hook dispatchers. They run `npm run check` before commits and
`npm run typecheck && npm test` before pushes. Run those gates explicitly when
the global hooks do not dispatch repository hooks.
