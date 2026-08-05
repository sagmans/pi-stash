# Scope stashes to exact working directories

pi-stash stores each stash under a key derived from the exact current working directory rather than discovering a shared Git repository identity. Separate linked worktrees therefore keep separate draft collections, while non-Git directories follow the same rule without a second identity model. This favors predictable editor context over sharing drafts across related checkouts.
