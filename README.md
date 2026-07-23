# pi-stash

Persistent editor draft stashes for [pi](https://github.com/earendil-works/pi-coding-agent).

`pi-stash` saves unsent editor text per working directory under
`~/.pi/agent/pi-stash/`, then restores it later without submitting it to a
model. Temporary pasted images are copied into private stash storage so restored
references survive OS cleanup.

## Features

- Stash the current editor draft and clear the editor.
- List, filter, preview, restore, drop, or clear saved drafts.
- Keep linked worktrees and ordinary directories isolated by exact working directory.
- Store entries newest-first with atomic writes, a cross-process lock, corrupt-file quarantine, and private permissions.
- Preserve referenced temporary images; leave repository and other stable absolute paths live.
- Integrate with `prefix-keybindings` when available; slash commands remain the fallback.

## Install

```bash
pi install npm:@sagmans/pi-stash
```

Install from npm so pi only offers updates after a published release.

## Usage

| Action | Command | Optional prefix binding |
| --- | --- | --- |
| Stash draft | `/stash [label]` | `prefix+s` |
| List drafts | `/stash-list` | `prefix+Shift+S` |
| Restore newest or selected entry | `/stash-pop [index-or-id]` | — |
| Delete newest or selected entry | `/stash-drop [index-or-id]` | — |
| Delete all entries | `/stash-clear` | — |

Index `0` is newest. Restore removes the entry but keeps copied images because
the restored editor text still references them. Drop and clear remove copied
images.

The optional shortcuts require a compatible `prefix-keybindings` extension.
Without it, pi-stash shows one notice and remains fully usable through slash
commands.

## Supported environments

| Component | Supported |
| --- | --- |
| OS | macOS (primary), Linux. Windows unsupported (POSIX permissions). |
| Node.js | `>=22.19.0` (CI tests `22.19.0` and `24`) |
| pi | tested at `0.81.1` |
| Terminal | tested under [Herdr](https://github.com/fitchmultz/herdr) and standard macOS terminals |
| Mode | TUI only. Sessions without UI remain inert. |

## Storage and privacy

Each exact working directory maps to one JSON file beneath
`~/.pi/agent/pi-stash/`; copied images live in an adjacent per-entry asset
directory. Directories use mode `0700` and files use `0600`. pi-stash performs no
network requests.

Stashes are local plaintext and may contain sensitive drafts. Protect the host
account and never share stash files or raw terminal captures without redaction.

## Documentation

- [`docs/maintainer-development.md`](https://github.com/sagmans/pi-stash/blob/main/docs/maintainer-development.md) — maintainer setup, commands, hooks
- [`docs/maintainer-smoke.md`](https://github.com/sagmans/pi-stash/blob/main/docs/maintainer-smoke.md) — disposable Herdr smoke test
- [`docs/adr/`](https://github.com/sagmans/pi-stash/tree/main/docs/adr) — architecture decision records
- [`CONTEXT.md`](https://github.com/sagmans/pi-stash/blob/main/CONTEXT.md) — domain language
- [`CONTRIBUTING.md`](https://github.com/sagmans/pi-stash/blob/main/CONTRIBUTING.md) — participation policy and bug reports
- [`SECURITY.md`](https://github.com/sagmans/pi-stash/blob/main/SECURITY.md) — vulnerability reporting
- [`RELEASE.md`](https://github.com/sagmans/pi-stash/blob/main/RELEASE.md) — release policy
- [`CHANGELOG.md`](https://github.com/sagmans/pi-stash/blob/main/CHANGELOG.md) — version history

## License

[MIT](LICENSE) · [Security](https://github.com/sagmans/pi-stash/blob/main/SECURITY.md) · [Report bugs](https://github.com/sagmans/pi-stash/blob/main/CONTRIBUTING.md) · [Releases](https://github.com/sagmans/pi-stash/blob/main/RELEASE.md)
