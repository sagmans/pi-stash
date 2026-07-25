#!/usr/bin/env bash
# Provision the GitHub controls required by RELEASE.md's npm OIDC boundary.
set -euo pipefail

readonly ENV_NAME="npm-release"
readonly RULESET_NAME="release-tags-admin-only"
readonly ADMIN_ROLE_ID="5"
readonly RULESET_QUERY='[.[] | select(.name == "release-tags-admin-only" and .source_type == "Repository")][0].id // empty'
readonly USAGE="usage: setup-github-oidc-release.sh <owner/repo> <reviewer-login> [tag-pattern]"

fail() {
	printf 'release setup failed: %s\n' "$1" >&2
	exit 1
}

[[ $# -ge 2 && $# -le 3 ]] || fail "$USAGE"
readonly REPO="$1"
readonly REVIEWER="$2"
readonly TAG_PATTERN="${3:-v*}"

# Strict syntax keeps every value both API-safe and narrower than an arbitrary ref glob.
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "invalid owner/repository"
repo_owner="${REPO%%/*}"
repo_name="${REPO#*/}"
[[ "$repo_owner" != "." && "$repo_owner" != ".." && "$repo_name" != "." && "$repo_name" != ".." ]] ||
	fail "invalid owner/repository"
[[ "$REVIEWER" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$ && "$REVIEWER" != *--* ]] ||
	fail "invalid reviewer login"
[[ ${#TAG_PATTERN} -le 64 && "$TAG_PATTERN" =~ ^v[A-Za-z0-9.*_-]*$ ]] ||
	fail "invalid or over-broad tag pattern"
command -v gh >/dev/null 2>&1 || fail "gh is required"
command -v node >/dev/null 2>&1 || fail "node is required"

reviewer_id="$(gh api "users/${REVIEWER}" --jq '.id')"
[[ "$reviewer_id" =~ ^[1-9][0-9]*$ ]] || fail "GitHub returned an invalid reviewer id"

environment_payload="$(node -e '
const reviewerId = Number(process.argv[1]);
process.stdout.write(JSON.stringify({
  can_admins_bypass: false,
  reviewers: [{ type: "User", id: reviewerId }],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
}));
' "$reviewer_id")"
printf '%s' "$environment_payload" |
	gh api "repos/${REPO}/environments/${ENV_NAME}" -X PUT --input - >/dev/null

# API policy creation is not idempotent, so compare the literal existing names first.
if ! gh api "repos/${REPO}/environments/${ENV_NAME}/deployment-branch-policies" \
	--jq '.branch_policies[].name' | grep -Fqx -- "$TAG_PATTERN"; then
	gh api "repos/${REPO}/environments/${ENV_NAME}/deployment-branch-policies" \
		-X POST -f "name=${TAG_PATTERN}" -f "type=tag" >/dev/null
fi

ruleset_payload="$(node -e '
const [name, tagPattern, adminRoleId] = process.argv.slice(1);
process.stdout.write(JSON.stringify({
  name,
  target: "tag",
  enforcement: "active",
  conditions: { ref_name: { include: [`refs/tags/${tagPattern}`], exclude: [] } },
  rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
  bypass_actors: [{
    actor_id: Number(adminRoleId),
    actor_type: "RepositoryRole",
    bypass_mode: "always",
  }],
}));
' "$RULESET_NAME" "$TAG_PATTERN" "$ADMIN_ROLE_ID")"
ruleset_id="$(gh api "repos/${REPO}/rulesets" --jq "$RULESET_QUERY")"
if [[ -n "$ruleset_id" ]]; then
	[[ "$ruleset_id" =~ ^[1-9][0-9]*$ ]] || fail "GitHub returned an invalid ruleset id"
	printf '%s' "$ruleset_payload" |
		gh api "repos/${REPO}/rulesets/${ruleset_id}" -X PUT --input - >/dev/null
else
	printf '%s' "$ruleset_payload" |
		gh api "repos/${REPO}/rulesets" -X POST --input - >/dev/null
fi

printf 'done: %s — env %s, reviewer %s, tag policy %s, ruleset %s\n' \
	"$REPO" "$ENV_NAME" "$REVIEWER" "$TAG_PATTERN" "$RULESET_NAME"
