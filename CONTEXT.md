# pi-stash Runtime

Language for pi-stash draft persistence and worktree isolation.

## Language

**Draft**:
The unsent text currently held by pi's interactive editor.
_Avoid_: Prompt, message

**Stash entry**:
One persisted draft, creation time, count of copied temporary images, and any legacy label retained from older storage.
_Avoid_: History entry, saved prompt

**Stash**:
The newest-first collection of stash entries belonging to one worktree scope.
_Avoid_: History, queue

**Worktree scope**:
The exact current working directory whose drafts share one private stash file; linked worktrees remain separate.
_Avoid_: Repository scope, project scope

**Restore**:
Place a stash entry into the editor and remove that entry from the stash while retaining copied assets referenced by its text. `/stash-pop` is a command alias for restoring the newest entry.
_Avoid_: Pop when describing user behavior outside the literal command name

**Drop**:
Delete a stash entry and its copied assets without placing its draft into the editor.
_Avoid_: Clear

**Clear**:
After confirmation, delete every stash entry and copied asset for the current worktree scope.
_Avoid_: Drop

**Persisted image**:
A temporary-directory image copied into private stash storage so a restored draft retains a valid reference.
_Avoid_: Attachment, uploaded image

**Pending asset cleanup**:
A durable asset-directory identifier retained after its owning entry is deleted, until best-effort removal succeeds and is acknowledged.
_Avoid_: Orphan, cache

**Operational notice**:
A local runtime message intended for the current user; it is not stable or safe to share without redaction.
_Avoid_: Diagnostic, log
