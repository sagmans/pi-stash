#!/usr/bin/env bash
set -euo pipefail

readonly TESTED_HERDR_VERSION="0.8.0"
readonly READY_TIMEOUT_MS="30000"
readonly ACTION_TIMEOUT_MS="30000"
readonly PANE_RATIO="0.5"
readonly PROCESS_EXIT_GRACE_SECONDS="1"
readonly PRIVATE_DIR_MODE="700"
readonly PRIVATE_FILE_MODE="600"
readonly STASH_SHORTCUT="ctrl+alt+h"
readonly SMOKE_CANARY="PI_STASH_SMOKE_DRAFT_7E4A9C2D"

package_input="${1:-}"
smoke_root=""
clipboard_image=""
pane_id=""

close_pane() {
	if [[ -z "$pane_id" ]]; then return 0; fi
	herdr pane run "$pane_id" "/exit" >/dev/null 2>&1 || true
	sleep "$PROCESS_EXIT_GRACE_SECONDS"
	if herdr pane get "$pane_id" >/dev/null 2>&1; then
		herdr pane close "$pane_id" >/dev/null 2>&1 || return 1
	fi
	pane_id=""
}

cleanup() {
	local exit_code=$?
	trap - EXIT INT TERM
	close_pane || exit_code=1
	if [[ -n "$clipboard_image" ]]; then rm -f -- "$clipboard_image"; fi
	if [[ -n "$smoke_root" ]]; then rm -rf -- "$smoke_root"; fi
	if [[ (-n "$clipboard_image" && -e "$clipboard_image") || (-n "$smoke_root" && -e "$smoke_root") ]]; then
		printf 'pi-stash Herdr smoke failed: residual disposable data\n' >&2
		exit_code=1
	fi
	exit "$exit_code"
}
trap cleanup EXIT INT TERM

fail() {
	printf 'pi-stash Herdr smoke failed: %s\n' "$1" >&2
	exit 1
}

require_command_surface() {
	local pane_help
	pane_help="$(herdr pane 2>&1 || true)"
	for command in "pane split" "pane run" "pane send-keys" "pane read" "pane close" "pane wait-output"; do
		[[ "$pane_help" == *"$command"* ]] || fail "Herdr lacks required '$command' command"
	done
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

assert_clean_output() {
	local capture
	capture="$(herdr pane read "$pane_id" --source recent-unwrapped --lines 400)" || fail "unable to inspect Pi output"
	if [[ "$capture" =~ Warning|ExperimentalWarning|extension_error|PI_STASH_SMOKE_FAILED ]]; then
		fail "Pi emitted a warning or extension failure"
	fi
}

create_pane() {
	local phase="$1" split_json launch_command
	split_json="$(
		herdr pane split --current --direction right --ratio "$PANE_RATIO" --cwd "$repo_root" \
			--env "TMPDIR=$tmp_root" \
			--env "HOME=$smoke_home" \
			--env "PI_CODING_AGENT_DIR=$agent_dir" \
			--env "PI_SKIP_VERSION_CHECK=1" \
			--env "PI_TELEMETRY=0" \
			--env "PI_STASH_SMOKE_PHASE=$phase" \
			--env "PI_STASH_SMOKE_EXTENSION=$extension_path" \
			--env "PI_STASH_SMOKE_IMAGE=$clipboard_image" \
			--env "PI_STASH_SMOKE_CANARY=$SMOKE_CANARY" \
			--no-focus
	)"
	pane_id="$(printf '%s' "$split_json" | parse_pane_id)" || fail "unable to parse created pane ID"
	[[ -n "$pane_id" ]] || fail "Herdr did not return a pane ID"
	herdr pane wait-output "$pane_id" --match "$(basename -- "$repo_root")" --source recent-unwrapped \
		--timeout "$READY_TIMEOUT_MS" >/dev/null || fail "created shell did not become ready"

	printf -v launch_command 'exec env TMPDIR=%q HOME=%q PI_CODING_AGENT_DIR=%q PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 PI_STASH_SMOKE_PHASE=%q PI_STASH_SMOKE_EXTENSION=%q PI_STASH_SMOKE_IMAGE=%q PI_STASH_SMOKE_CANARY=%q %q --approve --no-session -e %q -e %q' \
		"$tmp_root" "$smoke_home" "$agent_dir" "$phase" "$extension_path" "$clipboard_image" "$SMOKE_CANARY" \
		"$pi_bin" "$extension_path" "$driver_path"
	herdr pane run "$pane_id" "$launch_command" >/dev/null
	herdr pane wait-output "$pane_id" --match "pi v$pi_version" --source recent-unwrapped \
		--timeout "$READY_TIMEOUT_MS" >/dev/null || fail "Pi TUI did not become ready"
}

[[ "${HERDR_ENV:-}" == "1" ]] || fail "HERDR_ENV=1 is required"
command -v herdr >/dev/null 2>&1 || fail "herdr is not available"
command -v node >/dev/null 2>&1 || fail "node is not available"
command -v tar >/dev/null 2>&1 || fail "tar is not available"
if [[ -z "$package_input" ]]; then
	command -v npm >/dev/null 2>&1 || fail "npm is not available"
fi
pi_bin="$(command -v pi || true)"
[[ -n "$pi_bin" ]] || fail "pi is not available"
require_command_surface
herdr pane current --current >/dev/null || fail "current Herdr pane is unavailable"
herdr_version="$(herdr --version)"
printf 'pi-stash Herdr smoke: %s (command surface tested with %s)\n' "$herdr_version" "$TESTED_HERDR_VERSION"

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
driver_path="$repo_root/scripts/smoke/driver.ts"
[[ -f "$driver_path" ]] || fail "smoke driver is unavailable"
tmp_root="$(node -p 'require("node:os").tmpdir()')"
smoke_root="$(mktemp -d "$tmp_root/pi-stash-herdr-smoke.XXXXXX")"
smoke_home="$smoke_root/home"
agent_dir="$smoke_root/agent"
stash_dir="$agent_dir/pi-stash"
artifact_dir="$smoke_root/artifact"
package_root="$smoke_root/runtime"
umask 077
mkdir -p -- "$smoke_home" "$agent_dir" "$stash_dir" "$artifact_dir" "$package_root"
chmod "$PRIVATE_DIR_MODE" "$smoke_home" "$agent_dir" "$stash_dir" "$artifact_dir" "$package_root"

if [[ -n "$package_input" ]]; then
	package_artifact="$(cd -- "$(dirname -- "$package_input")" && pwd -P)/$(basename -- "$package_input")"
else
	package_name="$(cd -- "$repo_root" && npm pack --silent --pack-destination "$artifact_dir")"
	package_artifact="$artifact_dir/$(basename -- "$package_name")"
fi
[[ -f "$package_artifact" ]] || fail "package artifact is unavailable"
tar -xzf "$package_artifact" -C "$package_root"
extension_path="$package_root/package/index.ts"
[[ -f "$extension_path" ]] || fail "packaged extension entry point is unavailable"

clipboard_image="$tmp_root/pi-clipboard-$(node -e 'process.stdout.write(require("node:crypto").randomUUID())').png"
node -e '
const { writeFileSync } = require("node:fs");
writeFileSync(process.argv[1], Buffer.from("89504e470d0a1a0a", "hex"), { mode: 0o600, flag: "wx" });
' "$clipboard_image"
chmod "$PRIVATE_FILE_MODE" "$clipboard_image"
pi_version="$($pi_bin --version)"

create_pane stash
herdr pane wait-output "$pane_id" --match "PI_STASH_SMOKE_STASH_READY" --source recent-unwrapped \
	--timeout "$ACTION_TIMEOUT_MS" >/dev/null || fail "synthetic draft was not ready"
herdr pane send-keys "$pane_id" "$STASH_SHORTCUT" >/dev/null
herdr pane wait-output "$pane_id" --match "PI_STASH_SMOKE_STASHED" --source recent-unwrapped \
	--timeout "$ACTION_TIMEOUT_MS" >/dev/null || fail "default native shortcut did not stash draft"
assert_clean_output
stash_file="$(node -e '
const { existsSync, lstatSync, readFileSync, readdirSync } = require("node:fs");
const path = require("node:path");
const [dir, canary, sourceImage] = process.argv.slice(1);
const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
if (files.length !== 1) process.exit(1);
const filePath = path.join(dir, files[0]);
const file = JSON.parse(readFileSync(filePath, "utf8"));
if (typeof file.cwd !== "string" || !Array.isArray(file.entries) || file.entries.length !== 1) process.exit(1);
const entry = file.entries[0];
if (entry.assetCount !== 1 || !entry.text.includes(canary) || entry.text.includes(sourceImage)) process.exit(1);
const image = entry.text.split("\n").at(-1);
const assetsRoot = `${path.join(dir, `${file.cwd}-assets`)}${path.sep}`;
if (typeof image !== "string" || !image.startsWith(assetsRoot) || !existsSync(image) || !lstatSync(image).isFile()) process.exit(1);
process.stdout.write(filePath);
' "$stash_dir" "$SMOKE_CANARY" "$clipboard_image")" || fail "durable text and image stash state is invalid"
close_pane || fail "first Pi launch left a live process"

create_pane restore
herdr pane wait-output "$pane_id" --match "PI_STASH_SMOKE_RESTORE_READY" --source recent-unwrapped \
	--timeout "$ACTION_TIMEOUT_MS" >/dev/null || fail "second Pi launch did not load packaged commands"
herdr pane run "$pane_id" "/stash-pop" >/dev/null
herdr pane wait-output "$pane_id" --match "$SMOKE_CANARY" --source recent-unwrapped \
	--timeout "$ACTION_TIMEOUT_MS" >/dev/null || fail "synthetic draft was not restored"
herdr pane wait-output "$pane_id" --match "PI_STASH_SMOKE_CLEANUP_READY" --source recent-unwrapped \
	--timeout "$ACTION_TIMEOUT_MS" >/dev/null || fail "restored editor was not cleared for cleanup"
herdr pane run "$pane_id" "/stash-cleanup" >/dev/null
herdr pane wait-output "$pane_id" --match "Asset cleanup: removed 1" --source recent-unwrapped \
	--timeout "$ACTION_TIMEOUT_MS" >/dev/null || fail "restored image cleanup did not complete"
assert_clean_output
node -e '
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const path = require("node:path");
const filePath = process.argv[1];
const file = JSON.parse(readFileSync(filePath, "utf8"));
if (!Array.isArray(file.entries) || file.entries.length !== 0) process.exit(1);
if (!Array.isArray(file.restoredAssetLeases) || file.restoredAssetLeases.length !== 0) process.exit(1);
if (!Array.isArray(file.pendingAssetCleanup) || file.pendingAssetCleanup.length !== 0) process.exit(1);
const assetsRoot = path.join(path.dirname(filePath), `${file.cwd}-assets`);
if (existsSync(assetsRoot) && readdirSync(assetsRoot).length !== 0) process.exit(1);
' "$stash_file" || fail "restored stash or image cleanup remained on disk"
close_pane || fail "second Pi launch left a live process"

printf 'pi-stash Herdr smoke passed: packaged draft and image survived two launches, restored, and were removed\n'
