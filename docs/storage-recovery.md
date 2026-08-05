# Storage, migration, and recovery

This guide describes pi-stash's local data boundary and safe responses to
operational notices. Exit every Pi process using the affected worktree scope
before copying, inspecting, or changing recovery files.

## Storage boundary

Each exact current working directory maps to one JSON stash file under the
configured Pi agent directory's `pi-stash/` subtree. The normal root is
`~/.pi/agent/pi-stash/`; `PI_CODING_AGENT_DIR` and Pi's other supported agent
configuration can place it elsewhere. A versioned, escaped working-directory
key names the JSON file and adjacent copied-image tree.

Stash text is local plaintext. pi-stash code performs no network requests during
operation, but it executes inside Pi with the local user's full privileges.
Directories are created or repaired to mode `0700`; JSON, metadata, and copied
image files use `0600`. Existing storage must be owned by the current user.
Symbolic links, foreign-owned paths, and unexpected file types are rejected
rather than followed. These POSIX guarantees are why native Windows is not
supported.

Atomic-write temporary files, lock directories and their reclamation guards,
crash-recovery intents, and migration markers can briefly appear beside a
stash. Do not edit or delete them while Pi is running.

## Persisted image ownership and retention

pi-stash copies only direct files in the operating-system temporary directory
whose names match Pi's `pi-clipboard-<UUID>` convention and whose extension and
file signature identify PNG, JPEG, GIF, WebP, or BMP data. Repository paths and
other absolute paths stay unchanged and are never owned or deleted by pi-stash.

A draft can own at most 10 distinct copied images, 20 MiB per image, and 50 MiB
of distinct image bytes in total. Repeated references to identical bytes share
one owned copy. The source is read from one validated file descriptor, and the
copy is committed under that stash entry's private asset directory.

Stash entries remain until restored, dropped, or cleared; there is no automatic
age or count expiry. Restore removes the entry but records a durable lease for
its copied images because the restored editor text still references them.
`/stash-cleanup` retains leases referenced by the current editor and queues the
rest for deletion. Close other Pi sessions for the same worktree scope before
running cleanup, because it can only inspect the current editor. Restashing a
restored draft transfers referenced owned images into the new entry.

Drop and confirmed clear commit entry removal before best-effort asset deletion.
A cleanup failure therefore does not restore the deleted draft: the asset ID
stays in pending cleanup and is retried during later session startup or
`/stash-cleanup`. Deletion is ordinary filesystem removal, not secure erasure.

## Automatic migration

When Pi's configured agent directory differs from the historical fixed
`~/.pi/agent` location, startup checks the legacy `~/.pi/agent/pi-stash/` root
for the current worktree scope only. If the configured destination is empty,
pi-stash copies normalized state and only assets owned by that scope, verifies
the destination, then removes the migrated source. A private marker makes an
interrupted migration resumable.

A pre-existing destination, malformed legacy state or marker, missing required
asset, unsafe file, or conflicting copied bytes stops migration. pi-stash does
not overwrite either stash to guess at a merge. Exit Pi, back up both roots and
any marker, and resolve the conflict with a trusted copy of the same or newer
extension before retrying. Schema version 1 files in an otherwise current root
are upgraded atomically to schema version 2 on load.

## Recovery notices

### Unsupported schema

A schema newer than this release remains in place and disables pi-stash for that
worktree scope. Do not run clear, downgrade the file, or hand-edit its version.
Upgrade pi-stash first. If no compatible release exists, exit Pi and copy the
untouched JSON and adjacent asset tree for non-destructive offline export.

### Quarantined corruption

Malformed JSON, invalid schema fields, duplicate ownership, or a mismatched
worktree key is moved to a collision-safe `.corrupt-<timestamp>` recovery path.
The active scope then starts empty, and the operational notice reports the
quarantine path. Exit Pi before recovery, copy the quarantined file and adjacent
assets, and preserve any newly created active stash separately. Never rename
unverified data over the active file. Repair or extract drafts only from a copy;
pi-stash intentionally provides no destructive automatic import.

### Cleanup failure

The draft action may already be committed while copied-image removal failed.
Keep the pending metadata and asset directory intact. Close other Pi sessions
for the scope, then run `/stash-cleanup` or restart Pi to retry pending cleanup.
If failure persists, back up the whole scope and inspect ownership, permissions,
free space, and path types without replacing links or weakening permissions.

### Interrupted mutation or stale lock

Startup reconciles abandoned add and restore intents: uncommitted staged assets
are removed, while a restore removed before editor acknowledgement is returned
to the stash. Assets leased to a restored draft are treated as committed
ownership and are never removed by intent recovery. Provably dead local locks
and stale malformed locks are reclaimed, and the same rules reclaim orphaned
lock-reclamation guards. Live, foreign-host, or uncertain locks fail closed
after a timeout; fresh malformed metadata is diagnosed without immediate
removal. Close other sessions and retry before considering offline recovery.

## Non-destructive recovery checklist

1. Stop all Pi processes using the exact worktree scope.
2. Copy the reported JSON, its adjacent asset tree, and any marker or intent
   directory to private backup storage; keep modes `0700`/`0600`.
3. Record the pi-stash version, Pi version, configured agent directory, exact
   working directory, and sanitized error text. Never share draft contents or
   private paths.
4. Prefer upgrading and retrying over editing. Work only on a backup if manual
   extraction is unavoidable.
5. Report reproducible defects with synthetic data through the documented bug
   or private security channel.
