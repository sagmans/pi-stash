# Maintainer smoke test

Use this maintainer-only Herdr smoke after runtime-loading or storage changes.
It launches the checkout as a real Pi TUI package without reading or mutating
the user's configured Pi agent directory.

## Preconditions

- Run inside a Herdr-managed pane with `HERDR_ENV=1`.
- Install `herdr`, `pi`, Node.js, and the locked project dependencies.
- The command surface is tested with Herdr `0.7.4`; the script reports the
  installed version and checks required commands before creating anything.

From the repository root:

```bash
npm ci --ignore-scripts
npm run smoke:herdr
```

The smoke is intentionally outside `npm run verify:ci`; Herdr is maintainer
infrastructure, not a package-user or CI dependency.

## Isolation and evidence

The script:

1. Creates disposable `HOME` and `PI_CODING_AGENT_DIR` trees.
2. Seeds one synthetic stash entry for the checkout's exact working directory.
3. Opens a non-focused sibling pane and launches
   `pi --approve --no-session -e .` with one-run project trust, update checks,
   and telemetry disabled.
4. Invokes `/stash-pop` without sending a model prompt and waits for the
   synthetic draft to appear in the editor.
5. Verifies the persisted stash is now empty, keeps raw pane output only in
   memory, and prints no draft or private path.
6. Requests a clean Pi exit, closes only the pane it created, and removes all
   disposable state on success or failure.

Never persist or share raw TUI capture: the editor contains the synthetic canary
and Pi may render repository and disposable paths unrelated to pi-stash.

## Common failures

- `HERDR_ENV=1 is required`: run the smoke from a Herdr-managed pane.
- Missing Herdr command: install a compatible Herdr version and compare its
  reported command surface with tested version `0.7.4`.
- `pi is not available`: install a supported Pi version or add it to `PATH`.
- Pi readiness timeout: confirm the local TUI can launch with disposable state.
- Draft restore or storage mismatch: treat runtime behavior as failed; do not
  share captured pane output.
