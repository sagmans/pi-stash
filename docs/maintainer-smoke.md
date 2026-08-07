# Maintainer smoke test

Use this maintainer-only Herdr smoke after runtime-loading, command-adapter, or
storage changes. It runs the packaged extension through two real Pi TUI
launches without reading or mutating the user's configured Pi agent directory.

## Preconditions

- Run inside a Herdr-managed pane with `HERDR_ENV=1`.
- Install `herdr`, `pi`, Node.js, `tar`, and locked project dependencies. npm is required only when packing current checkout.
- The command surface is tested with Herdr `0.8.0`; the script reports the
  installed version and checks required commands before creating anything.

From the repository root:

```bash
npm ci --ignore-scripts
npm run smoke:herdr
```

With an exact package artifact downloaded from CI or built separately:

```bash
npm run smoke:herdr -- /absolute/path/to/sagmans-pi-stash-X.Y.Z.tgz
```

Without an argument, the script runs `npm pack` and tests that artifact. The
smoke remains outside `npm run verify:ci`; Herdr is maintainer infrastructure,
not a package-user dependency. To reproduce a release run, download its
`npm-package` artifact, then pass the single `.tgz` to the second command.

## Isolation and evidence

The script:

1. Creates disposable `HOME` and `PI_CODING_AGENT_DIR` trees plus synthetic text,
   a reversible legacy stash, and a minimal clipboard-image fixture under the
   operating-system temp root.
2. Extracts the supplied package, or packs the checkout, and loads only its
   public extension entry point alongside a maintainer smoke driver.
3. Opens a non-focused pane and launches Pi with one-run project trust, update
   checks, and telemetry disabled. The driver verifies `/stash`,
   `/stash-restore`, `/stash-pop`, and `/stash-cleanup` came from packaged entry point,
   then Herdr sends default native stash shortcut with synthetic editor draft.
4. Verifies the editor cleared and durable state owns one copied image, exits
   the first Pi process, and closes its pane.
5. Starts a fresh pane and Pi process, invokes `/stash-migrate`, verifies the
   synthetic legacy source moved into configured storage, invokes `/stash-pop`,
   verifies the full draft reappears, clears the synthetic editor, invokes
   `/stash-cleanup`, and confirms the entry, restored-image lease, cleanup queue,
   and copied image are gone.
6. Fails on timeouts, warnings, extension errors, live created panes, malformed
   state, or residual disposable data. Raw pane output remains in memory and
   only one concise pass/fail line is printed.

Never persist or share raw TUI capture: it can contain the synthetic canary,
repository path, and disposable paths.

## Common failures

- `HERDR_ENV=1 is required`: run from a Herdr-managed pane.
- Missing Herdr command: install a compatible Herdr version and compare its
  reported command surface with tested version `0.8.0`.
- `pi is not available`: install the supported Pi version or add it to `PATH`.
- Pi readiness/action timeout: inspect locally; never share raw pane capture.
- Packaged command provenance failure: ensure the `.tgz` is the intended CI
  artifact and no duplicate extension is explicitly loaded.
- Draft, image, or storage mismatch: treat runtime behavior as failed.
