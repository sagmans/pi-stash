# Changelog

All notable changes to this project are documented here. This format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Respect Pi's configured agent directory for storage and repair private asset-directory permissions.
- Preserve image paths containing spaces or adjacent punctuation, and roll back partial asset staging.
- Make entry deletion, restored-image transfer, and retryable asset cleanup durable across failures and restarts.
- Serialize stash actions, await them during shutdown, and suppress inactive prefix or pending-overlay actions.
- Recover abandoned lock-reclamation guards and roll back editor restore when persistence fails.
- Align release package-content guidance and treat literal tag policy patterns idempotently.

## [0.1.0] - 2026-07-23

### Added

- Persistent worktree-scoped editor draft stashes with newest-first restore, drop, list, and clear commands.
- Searchable TUI overlay, above-editor stash widget, and optional `prefix-keybindings` integration.
- Private atomic storage with cross-process locking, corrupt-file quarantine, and temporary-image persistence.
- Cross-platform CI matrix, dependency audit gate, isolated Herdr smoke, and approval-gated npm OIDC release workflow.

[Unreleased]: https://github.com/sagmans/pi-stash/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sagmans/pi-stash/releases/tag/v0.1.0
