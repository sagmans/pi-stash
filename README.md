# pi-stash

Persistent editor draft stashes for [pi](https://github.com/earendil-works/pi-coding-agent).

`pi-stash` saves unsent editor text per exact working directory under the
configured Pi agent directory's `pi-stash/` subtree, then restores it without
submitting it to a model. Recognized temporary clipboard images are copied into
private stash storage so restored references survive OS cleanup.

## Features

- Save and restore unsent drafts without submitting them to a model.
- List, filter, preview, restore, drop, or clear newest-first entries.
- Isolate storage by exact working directory, including linked worktrees.
- Persist recognized temporary clipboard images; ignore other absolute paths.
- Protect data with private permissions, atomic writes, locking, crash recovery, and corruption quarantine.
- Support optional `prefix-keybindings`; slash commands always work.

## Install

> **Security:** Pi does not sandbox extensions. pi-stash runs with
> Pi's full local privileges. Review the package before installing. Runtime code
> makes no network requests, but this is not a sandbox boundary.

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

Index `0` is newest. Selectors accept a displayed index or exact entry ID.
Restore requires an empty editor and removes the entry. Drop and confirmed clear
queue owned images for deletion. `/stash-cleanup` retries image cleanup; close
other Pi sessions for the same scope first.

The overlay supports configured navigation and confirmation keys, typing to
filter, preview, `F5` refresh, and `d` to drop. Without compatible
`prefix-keybindings`, slash commands remain available.

## Limits

- Draft count and text size have no application limit; private storage capacity is the bound.
- Widget: 5 entry rows. Overlay list: 10 entry rows. Wrapped preview: 10 terminal rows.
- Persisted images: 10 distinct images per draft, 20 MiB each, 50 MiB total distinct bytes.
- Worktree storage key: at most 200 UTF-8 bytes before file or directory suffixes.

## Storage, privacy, and recovery

Stashes are local plaintext with private POSIX permissions and no automatic
expiry. pi-stash rejects unsafe paths and ownership, preserves unsupported
schemas, quarantines invalid current data, and retains failed cleanup for retry.

Read [storage and recovery](docs/storage-recovery.md) before inspecting or
changing stash files. Never share stash data or raw terminal captures without
redaction.

## Documentation

- [Storage and recovery](docs/storage-recovery.md)
- [Maintainer development](docs/maintainer-development.md) and [smoke test](docs/maintainer-smoke.md)
- [Architecture decisions](docs/adr/) and [domain language](CONTEXT.md)
- [Participation](CONTRIBUTING.md), [security](SECURITY.md), [releases](RELEASE.md), and [changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
