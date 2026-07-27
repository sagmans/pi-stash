# pi-stash

Persistent editor draft stashes for [pi](https://github.com/earendil-works/pi-coding-agent).

`pi-stash` saves unsent editor text per exact working directory under the
configured Pi agent directory's `pi-stash/` subtree, then restores it without
submitting it to a model. Recognized temporary clipboard images are copied into
private stash storage so restored references survive OS cleanup.

## Features

- Stash the current editor draft and clear the editor after durable persistence.
- List, filter, preview, restore, drop, or clear newest-first entries.
- Keep linked worktrees and ordinary directories isolated by exact working directory.
- Use atomic writes, cross-process locking, crash recovery, corruption quarantine, and private permissions.
- Own only recognized temporary clipboard images; leave repository and other absolute paths unchanged.
- Integrate with `prefix-keybindings` when available; slash commands remain the fallback.

## Install

> **Security:** Pi does not sandbox extensions. Installing pi-stash executes its
> code with the coding agent's full local privileges, including access to files,
> processes, credentials available to Pi, and the network. Review and trust the
> package version before installing. pi-stash's runtime code performs no network
> requests, but that is an implementation property, not a sandbox boundary.

```bash
pi install npm:@sagmans/pi-stash
```

Install from npm so Pi offers updates only after a published release. Supported
runtime: macOS or Linux, Node.js `>=22.19.0`, Pi `0.82.1`, interactive TUI mode.
Native Windows is unsupported because storage relies on POSIX ownership and
permission guarantees.

## Usage

| Action | Command | Optional prefix binding |
| --- | --- | --- |
| Stash draft | `/stash [label]` | `prefix+s` |
| List drafts | `/stash-list` | `prefix+Shift+S` |
| Restore newest or selected entry | `/stash-pop [index-or-id]` | — |
| Delete newest or selected entry | `/stash-drop [index-or-id]` | — |
| Remove unreferenced restored images | `/stash-cleanup` | — |
| Delete all entries after confirmation | `/stash-clear` | — |

Index `0` is newest. Selectors accept a displayed zero-based index or exact
entry ID. Restore requires an empty editor. A successful restore removes the
entry but leases copied images while editor text references them. Drop and
confirmed clear remove entries first, then durably queue owned images for
best-effort deletion. `/stash-cleanup` removes leases not referenced by the
current editor and retries pending failures; close other Pi sessions for the
same scope before using it.

The list overlay supports configured up/down and confirm/cancel keys, typing to
filter, the configured preview key, `F5` refresh, and `d` to drop from preview.
Empty selections and missing selectors leave storage unchanged. Without a
compatible `prefix-keybindings` extension, one notice appears and every slash
command remains available.

## Limits

- Draft count and text size have no application limit; private storage capacity is the bound.
- Widget: 5 entry rows. Overlay list: 10 entry rows. Wrapped preview: 10 terminal rows.
- Persisted images: 10 distinct images per draft, 20 MiB each, 50 MiB total distinct bytes.
- Worktree storage key: at most 200 UTF-8 bytes before file or directory suffixes.

## Storage, privacy, and recovery

Stashes are local plaintext. Directories use `0700`; JSON, metadata, and copied
images use `0600`. pi-stash rejects links, foreign ownership, and unexpected
file types instead of following them. Entries have no automatic expiry.

Startup migrates the current scope from the historical fixed
`~/.pi/agent/pi-stash/` root when Pi now uses another configured agent
directory. It resumes interrupted migration but never guesses through a
conflicting destination. Unsupported future schemas remain untouched and make
the scope unavailable. Invalid current data is quarantined under a reported
recovery path. Cleanup failures retain retry metadata rather than resurrecting
deleted entries.

Read [storage, migration, image lifecycle, and non-destructive recovery](docs/storage-recovery.md)
before inspecting or changing stash files. Never share stash data or raw
terminal captures without redaction.

## Documentation

- [Storage and recovery](docs/storage-recovery.md) — location, migration, images, retention, failure handling
- [Maintainer development](docs/maintainer-development.md) — setup, checks, and hooks
- [Maintainer smoke](docs/maintainer-smoke.md) — packaged two-launch Herdr test
- [Architecture decisions](docs/adr/) — durable design choices
- [Domain language](CONTEXT.md) — precise runtime terminology
- [Participation policy](CONTRIBUTING.md) — bug reports and project scope
- [Security policy](SECURITY.md) — private vulnerability reporting
- [Release policy](RELEASE.md) — gates, waivers, and trusted publishing
- [Changelog](CHANGELOG.md) — version history

## License

[MIT](LICENSE) · [Security](SECURITY.md) · [Report bugs](CONTRIBUTING.md) · [Releases](RELEASE.md)
