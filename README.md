# pi-stash

Persistent editor draft stashes for [pi](https://github.com/earendil-works/pi-coding-agent).

`pi-stash` saves unsent editor text per exact working directory under the
configured Pi agent directory's `pi-stash/` subtree, then applies or pops it
without submitting it to a model. Recognized temporary clipboard images are
copied into private stash storage so later editor references survive OS cleanup.

## Features

- Save, apply, or pop unsent drafts without submitting them to a model.
- List, filter, preview, pop, drop, or clear newest-first entries.
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
runtime: macOS or Linux, Node.js `>=22.19.0`, Pi `0.84.3`, interactive TUI mode.
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
| Pop newest or selected entry into editor and remove it | `/stash-pop [index-or-id]` | — |
| List drafts | `/stash-list` | `Ctrl+Alt+L` |
| Delete newest or selected entry without using it | `/stash-drop [index-or-id]` | — |
| Apply newest or selected entry into editor without removing it | `/stash-apply [index-or-id]` | — |
| Delete all drafts and owned images after confirmation | `/stash-clear` | — |
| Migrate legacy scopes whose identity is provable; report the rest | `/stash-migrate` | — |
| Remove unreferenced images retained by earlier pops | `/stash-cleanup-images` | — |

`/stash <draft>` persists its argument without reading or clearing current
editor. Bare `/stash` shows usage. Shortcut stash persists current editor and
clears it only after successful persistence.

Index `0` is newest. Selectors accept a displayed index or exact entry ID.
Apply and pop require an empty editor; omitted selectors use the newest entry.
Apply keeps the entry, while pop removes it. The list overlay pops on confirmation
and can also drop entries from preview. Drop and confirmed clear queue owned
images for deletion.

A popped draft can still reference images copied into private stash storage, so
pi-stash retains those images after removing the entry. `/stash-cleanup-images`
keeps retained images referenced by the current editor, deletes unreferenced
ones, and retries failed image deletion. It never deletes draft text or stash
entries. Close other Pi sessions for the same scope first because cleanup can
inspect only the current editor.

Startup migrates the current working directory from either historical key
format because Pi supplies that scope's authoritative path. `/stash-migrate`
also sweeps globally reversible, untruncated v2 keys. Other non-injective v1
or truncated keys, competing sources, malformed state, and destination
conflicts remain untouched and are listed for private manual review.

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
    "list": "ctrl+alt+l"
  }
}
```

A missing override file falls back to the `config.json` shipped with the package; omitted keys fall back to that file's values. Unknown fields, malformed JSON, unsafe files,
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
