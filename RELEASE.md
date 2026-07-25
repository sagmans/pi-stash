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
4. Packaged two-launch smoke in a Herdr-managed pane against the exact candidate:

   ```bash
   npm run smoke:herdr
   ```

   The smoke packs the checkout, loads only that public package entry point,
   stashes synthetic multiline text and image data in disposable Pi state,
   exits, starts a fresh Pi process, restores through `/stash-pop`, and proves
   removal and cleanup. For a separately built candidate, pass its single
   `.tgz` after `--`; see [`docs/maintainer-smoke.md`](docs/maintainer-smoke.md).
5. README accuracy pass: every documented command/path still behaves as written.
6. Package-content pass: `npm pack --dry-run` contains only the runtime files
   and package-relative documentation declared by `package.json`, plus npm's
   mandatory metadata, README, and LICENSE; it contains no local state, tests,
   smoke drivers, release scripts, or other maintainer tooling.
7. Changelog roll-forward: `CHANGELOG.md` carries a new dated `[X.Y.Z]`
   section for the target version with the relevant `Unreleased` entries,
   and exactly one `Unreleased` section remains.
8. Waiver evidence (only if a gate above is waived): a durable, SHA-bound
   waiver record written by the release owner exists against the exact
   candidate SHA. With no waiver record, the tag cannot be created and
   publication cannot be approved.

A gate may only be waived by the release owner. Each waived gate requires one
record using the canonical format below; blanket or multi-gate waivers are
invalid. Preserve the validated JSON verbatim in an owner-protected, durable
approval record bound to the candidate SHA before tagging. Reproduce it in the
published GitHub release notes after publication. The pre-tag record — not the
later GitHub release — authorizes tagging and publication approval.

```json
{
  "schemaVersion": 1,
  "candidateSha": "0123456789abcdef0123456789abcdef01234567",
  "scope": "gate-4",
  "owner": "sagmans",
  "reason": "Temporary infrastructure outage prevents the packaged runtime smoke.",
  "evidence": ["https://github.com/sagmans/pi-stash/actions/runs/123"],
  "createdAt": "2026-07-23T12:00:00.000Z",
  "expiresAt": "2026-07-24T12:00:00.000Z"
}
```

All eight fields are required and unknown fields fail validation. `scope` must
name exactly one of `gate-1` through `gate-7`; the candidate SHA and owner must
match the intended release, evidence must contain HTTPS URLs, timestamps must
be canonical UTC, and expiry may be at most 72 hours after creation. Validate
before creating the tag:

```bash
node scripts/release/validate-waiver.mjs \
  /path/to/waiver.json <candidate-sha> sagmans gate-4
```

Missing, malformed, expired, mismatched, unknown, or over-broad records exit
nonzero and cannot authorize a release.

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
tag push triggers the `release` workflow. Its `package` job creates one npm
artifact, then Ubuntu and macOS each verify that artifact on Node 22.19.0 and
24. The approval-gated `publish` job depends on the package job and the complete
matrix, so a failed, cancelled, skipped, or timed-out leg blocks publication.
It downloads and publishes the same digest-validated artifact; it never rebuilds
from a checkout. Inspect every matrix leg and the package job when publication
is blocked, then rerun the failed workflow only after correcting the candidate
or transient infrastructure failure.

After all jobs succeed, the workflow waits for the release owner's approval on
the `npm-release` environment and publishes through OIDC trusted publishing (no
npm token is stored anywhere; provenance attestations are generated
automatically). A waived gate cannot clear this approval without the SHA-bound
waiver record from gate 8.

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
