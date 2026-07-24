import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const SETUP_SCRIPT = path.resolve("scripts/release/setup-github-oidc-release.sh");

test("release setup treats an existing tag policy as a literal name", () => {
	const scratch = mkdtempSync(path.join(tmpdir(), "pi-stash-release-test-"));
	try {
		const callsFile = path.join(scratch, "gh-calls");
		const fakeGh = path.join(scratch, "gh");
		writeFileSync(
			fakeGh,
			`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_CALLS"
if [[ "$*" == "api users/reviewer --jq .id" ]]; then
  printf '42\\n'
elif [[ "$*" == *"deployment-branch-policies --jq"* ]]; then
  printf 'v*\\n'
elif [[ "$*" == *"rulesets --jq"* ]]; then
  exit 0
fi
`,
		);
		chmodSync(fakeGh, 0o755);

		execFileSync("bash", [SETUP_SCRIPT, "owner/repo", "reviewer", "v*"], {
			env: {
				...process.env,
				GH_CALLS: callsFile,
				PATH: `${scratch}${path.delimiter}${process.env.PATH ?? ""}`,
			},
		});

		const calls = readFileSync(callsFile, "utf8");
		assert.doesNotMatch(calls, /deployment-branch-policies -X POST/);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});
