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
- Provide native configurable shortcuts without requiring another extension.

## Install

> **Security:** Pi does not sandbox extensions. pi-stash runs with
> Pi's full local privileges. Review the package before installing. Runtime code
> makes no network requests, but this is not a sandbox boundary.

```bash
pi install npm:@sagmans/pi-stash
```

Install from npm so Pi offers updates only after a published release. Supported
runtime: macOS or Linux, Node.js `>=22.19.0`, Pi `0.83.0`, interactive TUI mode.
Native Windows is unsupported because storage relies on POSIX ownership and
permission guarantees.

Oh My Pi hosts the same package through its pi-compatible extension loader:

```bash
omp plugin install @sagmans/pi-stash
```

Oh My Pi support is contract-level: the extension matches Oh My Pi's documented
extension context and carries contract tests for it, but the packaged
two-launch runtime smoke has not been completed under Oh My Pi. Report
divergent behavior through the bug channel.

## Usage

| Action | Command | Default shortcut |
| --- | --- | --- |
| Stash supplied command text | `/stash <draft>` | — |
| Stash current editor draft | — | `Ctrl+Alt+S` |
| List drafts | `/stash-list` | `Ctrl+Alt+R` |
| Restore newest or selected entry | `/stash-restore [index-or-id]` | — |
| Pop newest entry into the editor | `/stash-pop` | — |
| Delete newest or selected entry | `/stash-drop [index-or-id]` | — |
| Remove unreferenced restored images | `/stash-cleanup` | — |
| Migrate every legacy stash scope, quarantining conflicts | `/stash-migrate` | — |
| Delete all drafts and owned images after confirmation | `/stash-clear` | — |

`/stash <draft>` persists its argument without reading or clearing current
editor. Bare `/stash` shows usage. Shortcut stash persists current editor and
clears it only after successful persistence.

Index `0` is newest. Selectors accept a displayed index or exact entry ID.
Restore requires an empty editor and removes the entry; bare `/stash-restore`
and `/stash-pop` both restore the newest entry. Drop and confirmed clear
queue owned images for deletion. `/stash-cleanup` retries image cleanup; close
other Pi sessions for same scope first.

Startup warns when any legacy stash scope conflicts with current data;
`/stash-migrate` sweeps every legacy scope — migrating clean ones, quarantining
conflicts as `*.migrate-conflict` files, and listing files that failed for
manual review or deletion.

The overlay supports configured navigation and confirmation keys, typing to
filter, preview, `F5` refresh, and `d` to drop.

### Shortcut configuration

Override either native shortcut in
`$PI_CODING_AGENT_DIR/pi-stash/config.json` (normally
`~/.pi/agent/pi-stash/config.json`):

```json
{
  "keybindings": {
    "stash": "ctrl+alt+s",
    "list": "ctrl+alt+r"
  }
}
```

Missing file or keys use defaults. Unknown fields, malformed JSON, unsafe files,
invalid shortcuts, and duplicate physical shortcuts fail extension loading.
Run `/reload` after changing config.

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
