# Release Policy

Applies to maintainers. Current release owner: repository owner
([`LICENSE`](LICENSE)).

## Versioning

[SemVer](https://semver.org). While at 0.x, minor bumps may contain breaking
changes; patch bumps are fixes only. The git tag (`vX.Y.Z`) and
`package.json` `version` must always match.

## Gates — all required before tagging

1. Candidate lands on `main` through a reviewed PR (squash merge).
2. Full CI matrix green on the exact merged SHA: Ubuntu + macOS ×
   Node 22.19.0 + 24, audit gate included.
3. `npm run verify:ci` green locally for the maintainer.
4. Install smoke in a disposable pi home against the exact SHA:

   ```bash
   smoke_root=$(mktemp -d)
   trap 'rm -rf -- "$smoke_root"' EXIT
   (
     export HOME="$smoke_root/home"
     export PI_CODING_AGENT_DIR="$smoke_root/agent"
     mkdir -p -- "$HOME" "$PI_CODING_AGENT_DIR"
     pi install git:github.com/sagmans/pi-stash@<sha>
     pi --approve --no-session
   )
   rm -rf -- "$smoke_root"
   trap - EXIT
   ```

   Keep every exercise inside that subshell. Exercise: stash a synthetic multiline draft, restart persistence,
   `/stash-list`, `/stash-pop`, `/stash-drop`, `/stash-clear`, optional
   `prefix+s` and `prefix+Shift+S` integration, and temporary-image restore.
5. README accuracy pass: every documented command/path still behaves as written.
6. Package-content pass: `npm pack --dry-run` contains only the runtime files
   declared by `package.json` plus npm's mandatory package metadata and standard
   documentation (`package.json`, README, and LICENSE); it contains no local
   state, tests, or maintainer tooling.
7. Changelog roll-forward: `CHANGELOG.md` carries a new dated `[X.Y.Z]`
   section for the target version with the relevant `Unreleased` entries,
   and exactly one `Unreleased` section remains.
8. Waiver evidence (only if a gate above is waived): a durable, SHA-bound
   waiver record written by the release owner exists against the exact
   candidate SHA. With no waiver record, the tag cannot be created and
   publication cannot be approved.

A gate may only be waived by the release owner. The waiver rationale is
recorded against the exact candidate SHA before tagging (gate 8) and
reproduced in the published GitHub release notes after publication; the
SHA-bound waiver record — not the later GitHub release — is what authorizes
the tag and publication approval.

## Tagging

Draft the GitHub release notes against the candidate SHA before tagging:
user-facing changes, fixes, contributors, and any pre-recorded gate waivers.
These drafted notes become the GitHub release only after npm publication
succeeds.

```bash
git tag -s -a vX.Y.Z -m "vX.Y.Z" <merged-sha>
git push origin vX.Y.Z
```

Tag creation for `v*` is restricted to repository admins by a ruleset. The
tag push triggers the `release` workflow: it re-verifies the candidate and
then waits for the release owner's approval on the `npm-release` environment
before publishing to npm via OIDC trusted publishing (no npm token is stored
anywhere; provenance attestations are generated automatically). A waived gate
cannot clear this approval without the SHA-bound waiver record from gate 8.

After publication, create the GitHub release from the tag using the drafted
notes.

## npm trusted publishing

The `@sagmans/pi-stash` package accepts publishes only from the `release`
workflow of this repository on the `npm-release` environment, configured under
package settings on npmjs.com. Package settings must also be set to "Require
two-factor authentication and disallow tokens" so the OIDC flow is the only
publish path. The release owner is the sole package maintainer.

The GitHub-side pieces (approval-gated `npm-release` environment, tag
deployment policy, admin-only tag ruleset) are provisioned by
[`scripts/release/setup-github-oidc-release.sh`](scripts/release/setup-github-oidc-release.sh),
which is idempotent and reusable for other repositories.

One-time bootstrap: trusted publishing requires the package to already exist
on npm, so the first release is published manually by the release owner
(`npm publish --access public` on the tagged SHA), after which the trusted
publisher is configured and automation takes over.

Configure npm trusted publishing with these exact values:

- Organization or user: `sagmans`
- Repository: `pi-stash`
- Workflow filename: `release.yml`
- Environment: `npm-release`
- Allowed action: `npm publish`

## Rollback

- **Bad tag/release:** keep the signed tag, source SHA, and GitHub release
  record intact. npm versions are immutable, and deleting these references
  breaks the source/notes chain and allows accidental tag-name reuse.
  Instead, deprecate the broken npm version with a reason and replacement
  (`npm deprecate @sagmans/pi-stash@<version> "<reason>; use
  @sagmans/pi-stash@<replacement> instead"`), edit the GitHub release notes to
  mark the version broken and point at the replacement, and publish a patch
  release restoring correct behavior.
- **Bad runtime behavior:** patch release; never silently rewrite or remove user
  stash data under the configured Pi agent directory's `pi-stash/` subtree.
- **Stash data:** older releases must never overwrite an unsupported schema.
  Any schema change requires a migration plan in the PR and a release note.
