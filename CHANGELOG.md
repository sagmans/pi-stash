# Changelog

All notable changes to this project are documented here. This format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Automatic configured-root and schema migration with resumable mutation recovery.
- Durable restored-image leases, explicit `/stash-cleanup`, and bounded two-launch package smoke coverage.
- SHA-bound release-waiver validation and full-matrix exact-artifact publication gates.
- Packaged storage, migration, lifecycle, and non-destructive recovery guidance.

### Changed

- Narrow the published module surface to the Pi installer and include package-relative documentation.
- Make widgets terminal-width aware and add searchable, refreshable, scrollable draft previews.
- Report effective prefix bindings per extension instance and keep slash commands as the reliable fallback.

### Fixed

- Preserve committed mutation outcomes across sync or lock-release failures and recover stale lock generations safely.
- Reject links, foreign ownership, unsafe entry IDs, and cross-entry asset ownership before filesystem mutation.
- Bound and validate clipboard-image intake while preserving exact bytes through pathname replacement races.
- Reconcile concurrent store and overlay changes without resurrecting removed or corrupt drafts.
- Cancel queued commands and overlays during shutdown and sanitize all untrusted terminal text.
- Keep unsupported future schemas untouched, quarantine current-schema corruption, and surface safe recovery guidance.
- Pass trusted-publishing JSON and command arguments without shell reinterpretation.

## [0.1.0] - 2026-07-23

### Added

- Persistent worktree-scoped editor draft stashes with newest-first restore, drop, list, and clear commands.
- Searchable TUI overlay, above-editor stash widget, and optional `prefix-keybindings` integration.
- Private atomic storage with cross-process locking, corrupt-file quarantine, and temporary-image persistence.
- Cross-platform CI matrix, dependency audit gate, isolated Herdr smoke, and approval-gated npm OIDC release workflow.

[Unreleased]: https://github.com/sagmans/pi-stash/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sagmans/pi-stash/releases/tag/v0.1.0
