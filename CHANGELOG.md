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
- Keep slash commands as the reliable fallback when no compatible prefix provider is active.

### Fixed

- Preserve committed mutation outcomes across sync or lock-release failures and recover stale lock generations safely.
- Reject links, foreign ownership, unsafe entry IDs, and cross-entry asset ownership before filesystem mutation.
- Preserve exact clipboard-image bytes through pathname replacement races and roll back partial staging.
- Reconcile concurrent store and overlay changes without resurrecting removed or corrupt drafts.
- Cancel queued commands and overlays during shutdown and sanitize all untrusted terminal text.
- Keep unsupported future schemas untouched while surfacing safe recovery guidance for corruption and cleanup failures.
- Pass trusted-publishing JSON and command arguments without shell reinterpretation.

[Unreleased]: https://github.com/sagmans/pi-stash/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sagmans/pi-stash/releases/tag/v0.1.0
