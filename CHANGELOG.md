# Changelog

All notable changes to this project are documented here. This format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Compatibility

- Verify Pi 1.3.0: the pre-push compatibility check now also runs against Pi 1.3.0 from its own committed lockfile, beside Pi 1.1.0 and the locked 0.87.0 baseline. The overlay needed no source change; one overlay test now ignores the invisible cursor markers that Pi 1.2.0 and later add to rendered input.

### Changed

- Release publication is automatic: a signed `v*` tag push by an admin now publishes to npm through OIDC trusted publishing, with no separate environment approval. The admin-only tag ruleset makes the tag push the release approval. The release setup script no longer takes a reviewer and provisions the `npm-release` environment without required reviewers. To return to manual approval, add a required reviewer to that environment.

### Security

- Development only: an npm override pins the Pi host's Undici dependency to 8.12.2 in the Pi 1.1.0 and 1.3.0 compatibility lockfiles, which fixes GHSA-xjj6-f33q-929c, GHSA-4qv8-2p9j-2685, and GHSA-f72v-6w45-q472. The pinned Pi versions are unchanged. The root manifest carries the same override because the compatibility check requires both manifests to match. The published package does not depend on Undici and is unchanged.
- Release only: the tag release workflow now packages, verifies, and publishes on Node.js `24.22.1` instead of the floating `24` line, which could resolve to a runtime without the 2026-10-21 security fixes for CVE-2026-111497 (Brotli decoder out-of-bounds write) and CVE-2026-105483 and CVE-2026-106069 (TLS hostname check bypass). The `engines` range and the published package are unchanged.

## [0.1.6] - 2026-10-14

### Compatibility

- Support Node.js 22, 24 and 26: `engines.node` is now `>=22.19.0`, and typecheck plus tests pass on Node 22.19.0, 24.21.0 and 26.11.1. Development types move to `@types/node` 26.6.5.
- The release-setup test's fake `gh` now runs from a `.cjs` file, so an unrelated `package.json` above the temp directory cannot make Node load it as an ES module.

### Compatibility

- Support Pi 1.x: the independent CI compatibility check now runs against Pi 1.1.0 instead of 0.99.1, alongside the locked 0.87.0 baseline. The extension needed no source changes; the Pi 1.0 to 1.1 changelog has no breaking change to the TUI surface it imports.

### Changed

- Update maintainer tooling (Biome 2.5.15, `@types/node` 26.6.4) and the pinned `actions/setup-node`, `actions/upload-artifact` and `actions/download-artifact` versions.

## [0.1.5] - 2026-09-30

### Compatibility

- Add an independent Pi 0.99.1 CI check while preserving the locked baseline.
- Use packaged readiness markers instead of the transient startup banner in the runtime smoke check.
- Verify the packaged two-launch smoke and combined editor checks on Pi 0.99.1.

### Changed

- Align the supported Pi TUI target, maintainer tooling, compatibility checks, and reporting guidance with Pi 0.87.0.
- Record the packaged two-launch smoke as passing with Pi 0.87.0 and Herdr 0.9.1.

### Fixed

- Accept the npm 12 `npm pack --dry-run --json` report shape in packaged content verification.

## [0.1.4] - 2026-08-24

### Changed

- Align the supported Pi TUI target, maintainer tooling, compatibility checks, and reporting guidance with Pi 0.84.3.
- Update the pinned Biome CLI to 2.5.10 and Node.js type definitions to 26.2.0.

## [0.1.3] - 2026-08-07

### Added

- Add `/stash-apply [index-or-id]` to use a draft without removing its stash entry.
- Add `/stash-migrate` to sweep legacy scopes whose working-directory identity can be proven.

### Changed

- Replace `/stash-restore` with selector-aware `/stash-pop [index-or-id]` and use Git-aligned pop/apply terminology.
- Rename `/stash-cleanup` to `/stash-cleanup-images` so its image-only scope is explicit.
- Source default shortcuts from the package's shipped `config.json`; private user overrides may remain partial.
- Use `Ctrl+Alt+S` and `Ctrl+Alt+L` as the default native shortcuts; the stash chord no longer aliases terminal `Alt+Backspace` input.
- Leave ambiguous, truncated, competing, malformed, and conflicting legacy sources untouched for private manual review instead of quarantining them automatically.

### Fixed

- Align the checked-in Biome schema with the pinned CLI so release verification is warning-free.
- Pin migration retries to one planned source, preserve typed conflict phases, decode the filesystem root, and cancel global sweeps between scopes.
- Track migration and session operations through the same abortable queue lifecycle, including unavailable sessions.

## [0.1.2] - 2026-08-07

### Fixed

- Publish the verified package through an explicit local tarball path so npm cannot reinterpret it as Git shorthand.
- Carry the legacy unprefixed stash-key migration fix from tagged but unpublished version 0.1.1.

## [0.1.1] - 2026-08-07

Version 0.1.1 was tagged but not published to npm because its publication job failed.

### Changed

- Run hosted source and release verification once on Ubuntu with Node 24 while retaining the documented runtime support contract.

### Fixed

- Discover and migrate historical unprefixed stash keys, including same-root upgrades, so existing drafts remain visible.

## [0.1.0] - 2026-08-05

### Added

- Persistent worktree-scoped editor draft stashes with newest-first restore, drop, list, clear, and cleanup commands.
- Searchable, refreshable, scrollable TUI overlay; terminal-width-aware widget; and native configurable stash/list shortcuts.
- Private atomic storage with cross-process locking, corruption quarantine, configured-root and schema migration, and resumable mutation recovery.
- Bounded clipboard-image persistence with durable restored-image leases and explicit `/stash-cleanup` retry.
- Full-matrix exact-artifact release gates, SHA-bound waiver validation, and packaged two-launch Herdr smoke coverage.
- Package-relative storage, migration, lifecycle, and non-destructive recovery guidance.

### Changed

- Narrow the published module surface to the Pi installer and include its operational documentation.
- Depend only on Pi's injected extension contract and the directly imported TUI surface, avoiding a duplicate host SDK and provider stack.
- Load native stash/list shortcuts from strict private `pi-stash/config.json`, with `Ctrl+Shift+S` and `Ctrl+Shift+R` defaults.
- Reduce internal filesystem, lifecycle, overlay, widget, test, and maintainer-tooling surfaces without changing stash behavior.
- Bundle stash operation context into one session target and align storage wording with the domain language.
- Rename `/stash-pop` to `/stash-restore` and the stash entry `message` field to `label` to match the domain language; files holding the legacy field still load with their labels intact.
- Host Oh My Pi's extension context, which omits the session mode reported by pi, and declare the `omp.extensions` manifest beside the legacy pi one; mode-less sessions activate only on a real terminal so ACP's stubbed UI cannot admit destructive commands.

### Fixed

- Preserve committed mutation outcomes across sync or lock-release failures and recover stale lock generations safely.
- Reject links, foreign ownership, unsafe entry IDs, and cross-entry asset ownership before filesystem mutation.
- Preserve exact clipboard-image bytes through pathname replacement races and roll back partial staging.
- Reconcile concurrent store and overlay changes without resurrecting removed or corrupt drafts.
- Cancel queued commands and overlays during shutdown and sanitize all untrusted terminal text.
- Keep unsupported future schemas untouched while surfacing safe recovery guidance for corruption and cleanup failures.
- Pass trusted-publishing JSON and command arguments without shell reinterpretation.
- Verify the installed TypeScript package entry outside Node's `node_modules` stripping boundary while preserving its default-only extension contract.
- Reject clipboard-image path prefixes with invalid filename suffixes, migrate restored-image leases, and sync final legacy-source removal before completing migration.
- Match mutation intents to process generations and finalize committed restore intents even when shutdown cancels subsequent UI work.
- Preserve restored-image leases when startup recovery reconciles a stale add intent, and treat a restore recovered by a concurrent session as complete instead of failing startup.
- Reclaim orphaned lock-reclamation guards so an interrupted reclaim cannot wedge a worktree scope, and stop waiting indefinitely behind a live guard.
- Load committed schema upgrades despite a failed directory sync, surfacing the durability warning once instead of disabling the scope.
- Clear restored-only image leases, distinguish cleanup removal from metadata acknowledgement, and verify copied-image removal in the packaged smoke.
- Preserve injected keybindings, classify post-commit durability and unlock failures by phase, and avoid treating no-op mutations as committed.
- Isolate process ownership, lock protocol, stash operations, and session state so recovery and UI behavior have focused ownership.
- Make `/stash <draft>` persist supplied command text while bare `/stash` reports usage and shortcut stash continues to consume current editor text.
- Run the packaged Herdr smoke on Herdr `0.8.0`, which replaces the `wait output` command with `pane wait-output`.
- Repeat smoke driver phase markers so the Herdr watcher cannot miss transient notifications between its own poll cycles.

[Unreleased]: https://github.com/sagmans/pi-stash/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/sagmans/pi-stash/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/sagmans/pi-stash/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/sagmans/pi-stash/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/sagmans/pi-stash/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/sagmans/pi-stash/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/sagmans/pi-stash/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sagmans/pi-stash/releases/tag/v0.1.0
