#!/usr/bin/env bash
set -euo pipefail

readonly TESTED_HERDR_VERSION="0.7.4"
readonly READY_TIMEOUT_MS="30000"
readonly RESTORE_TIMEOUT_MS="30000"
readonly PANE_RATIO="0.5"
readonly PRIVATE_DIR_MODE="700"
readonly PRIVATE_FILE_MODE="600"
readonly STASH_SCHEMA_VERSION="1"
readonly FIXTURE_ID="00000000-0000-4000-8000-000000000001"
readonly FIXTURE_TIMESTAMP="1767225600000"
readonly SMOKE_CANARY="PI_STASH_SMOKE_DRAFT_7E4A9C2D"
readonly SMOKE_DRAFT="Synthetic smoke draft"$'\n'"$SMOKE_CANARY"

smoke_root=""
pane_id=""

cleanup() {
	local exit_code=$?
	trap - EXIT INT TERM
	if [[ -n "$pane_id" ]]; then
		herdr pane run "$pane_id" "/exit" >/dev/null 2>&1 || true
		herdr pane close "$pane_id" >/dev/null 2>&1 || true
	fi
	if [[ -n "$smoke_root" && -d "$smoke_root" ]]; then
		rm -rf -- "$smoke_root"
	fi
	exit "$exit_code"
}
trap cleanup EXIT INT TERM

fail() {
	printf 'pi-stash Herdr smoke failed: %s\n' "$1" >&2
	exit 1
}

require_command_surface() {
	local pane_help wait_help
	pane_help="$(herdr pane 2>&1 || true)"
	wait_help="$(herdr wait 2>&1 || true)"
	for command in "pane split" "pane run" "pane read" "pane close"; do
		[[ "$pane_help" == *"$command"* ]] || fail "Herdr lacks required '$command' command"
	done
	[[ "$wait_help" == *"wait output"* ]] || fail "Herdr lacks required 'wait output' command"
}

parse_pane_id() {
	node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const id = JSON.parse(input)?.result?.pane?.pane_id;
  if (typeof id !== "string" || id.length === 0) process.exit(1);
  process.stdout.write(id);
});
'
}

[[ "${HERDR_ENV:-}" == "1" ]] || fail "HERDR_ENV=1 is required"
command -v herdr >/dev/null 2>&1 || fail "herdr is not available"
command -v node >/dev/null 2>&1 || fail "node is not available"
pi_bin="$(command -v pi || true)"
[[ -n "$pi_bin" ]] || fail "pi is not available"
require_command_surface
herdr pane current --current >/dev/null || fail "current Herdr pane is unavailable"
herdr_version="$(herdr --version)"
printf 'pi-stash Herdr smoke: %s (command surface tested with %s)\n' "$herdr_version" "$TESTED_HERDR_VERSION"

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
smoke_root="$(mktemp -d "${TMPDIR:-/tmp}/pi-stash-herdr-smoke.XXXXXX")"
smoke_home="$smoke_root/home"
agent_dir="$smoke_root/agent"
stash_dir="$agent_dir/pi-stash"
umask 077
mkdir -p -- "$stash_dir" "$agent_dir"
chmod "$PRIVATE_DIR_MODE" "$smoke_home" "$agent_dir" "$stash_dir"

stash_key="$(
	cd -- "$repo_root"
	node --experimental-transform-types --input-type=module -e '
import { sanitizeCwd } from "./src/paths.ts";
process.stdout.write(sanitizeCwd(process.argv[1]));
' "$repo_root"
)"
stash_file="$stash_dir/$stash_key.json"

node -e '
const { writeFileSync } = require("node:fs");
const [file, cwd, id, text, schemaVersion, timestamp] = process.argv.slice(1);
const time = Number(timestamp);
writeFileSync(file, `${JSON.stringify({
  schemaVersion: Number(schemaVersion),
  cwd,
  createdAt: time,
  updatedAt: time,
  entries: [{ id, text, createdAt: time }],
}, null, 2)}\n`, { mode: 0o600 });
' "$stash_file" "$stash_key" "$FIXTURE_ID" "$SMOKE_DRAFT" "$STASH_SCHEMA_VERSION" "$FIXTURE_TIMESTAMP"
chmod "$PRIVATE_FILE_MODE" "$stash_file"

split_json="$(
	herdr pane split --current --direction right --ratio "$PANE_RATIO" --cwd "$repo_root" \
		--env "HOME=$smoke_home" \
		--env "PI_CODING_AGENT_DIR=$agent_dir" \
		--env "PI_SKIP_VERSION_CHECK=1" \
		--env "PI_TELEMETRY=0" \
		--no-focus
)"
pane_id="$(printf '%s' "$split_json" | parse_pane_id)" || fail "unable to parse created pane ID"
[[ -n "$pane_id" ]] || fail "Herdr did not return a pane ID"
herdr wait output "$pane_id" --match "$(basename -- "$repo_root")" --source recent-unwrapped \
	--timeout "$READY_TIMEOUT_MS" >/dev/null || fail "created shell did not become ready"

pi_version="$($pi_bin --version)"
printf -v launch_command 'exec env HOME=%q PI_CODING_AGENT_DIR=%q PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 %q --approve --no-session -e .' \
	"$smoke_home" "$agent_dir" "$pi_bin"
herdr pane run "$pane_id" "$launch_command" >/dev/null
herdr wait output "$pane_id" --match "pi v$pi_version" --source recent-unwrapped \
	--timeout "$READY_TIMEOUT_MS" >/dev/null || fail "Pi TUI did not become ready"

herdr pane run "$pane_id" "/stash-pop" >/dev/null
herdr wait output "$pane_id" --match "$SMOKE_CANARY" --source recent-unwrapped \
	--timeout "$RESTORE_TIMEOUT_MS" >/dev/null || fail "synthetic draft was not restored"

node -e '
const { readFileSync } = require("node:fs");
const file = JSON.parse(readFileSync(process.argv[1], "utf8"));
if (!Array.isArray(file.entries) || file.entries.length !== 0) process.exit(1);
' "$stash_file" || fail "restored stash entry remained on disk"

printf 'pi-stash Herdr smoke passed: synthetic draft restored and removed from stash\n'
