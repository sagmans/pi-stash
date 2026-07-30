# Changelog

All notable changes to this project are documented here. This format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-25

### Added

- Persistent worktree-scoped editor draft stashes with newest-first restore, drop, list, clear, and cleanup commands.
- Searchable, refreshable, scrollable TUI overlay; terminal-width-aware widget; and optional per-instance `prefix-keybindings` integration.
- Private atomic storage with cross-process locking, corruption quarantine, configured-root and schema migration, and resumable mutation recovery.
- Bounded clipboard-image persistence with durable restored-image leases and explicit `/stash-cleanup` retry.
- Full-matrix exact-artifact release gates, SHA-bound waiver validation, and packaged two-launch Herdr smoke coverage.
- Package-relative storage, migration, lifecycle, and non-destructive recovery guidance.

### Changed

- Narrow the published module surface to the Pi installer and include its operational documentation.
- Depend only on Pi's injected extension contract and the directly imported TUI surface, avoiding a duplicate host SDK and provider stack.
- Keep slash commands as the reliable fallback when no compatible prefix provider is active.
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

[Unreleased]: https://github.com/sagmans/pi-stash/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sagmans/pi-stash/releases/tag/v0.1.0
