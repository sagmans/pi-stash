import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const SETUP_SCRIPT = path.resolve("scripts/release/setup-github-oidc-release.sh");
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.GH_CALLS, JSON.stringify({ args, input }) + "\\n");
  const endpoint = args[1] ?? "";
  if (endpoint.endsWith("deployment-branch-policies") && args.includes("--jq")) {
    process.stdout.write(process.env.GH_EXISTING_POLICY ?? "");
  }
});
`;

type GhCall = { args: string[]; input: string };

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function withFakeGh(run: (scratch: string, callsFile: string) => void): void {
	const scratch = mkdtempSync(path.join(tmpdir(), "pi-stash-release-test-"));
	try {
		// The fake's body lives in a .cjs file so an unrelated package.json above
		// the temp directory (for example a stray /tmp/package.json with
		// "type": "module") cannot make Node load it as an ES module. `gh` is a
		// shell shim because the setup script resolves `gh` from PATH.
		const fakeGhScript = path.join(scratch, "gh.cjs");
		const fakeGh = path.join(scratch, "gh");
		const callsFile = path.join(scratch, "gh-calls.jsonl");
		writeFileSync(fakeGhScript, FAKE_GH);
		writeFileSync(
			fakeGh,
			`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fakeGhScript)} "$@"\n`,
		);
		chmodSync(fakeGh, 0o755);
		run(scratch, callsFile);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

function runSetup(scratch: string, callsFile: string, args: string[]): GhCall[] {
	execFileSync("/bin/bash", [SETUP_SCRIPT, ...args], {
		env: {
			...process.env,
			GH_CALLS: callsFile,
			GH_EXISTING_POLICY: "v*\n",
			PATH: `${scratch}${path.delimiter}${process.env.PATH ?? ""}`,
		},
	});
	return readFileSync(callsFile, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as GhCall);
}

test("release setup passes exact arguments and structured JSON without reinterpretation", () => {
	withFakeGh((scratch, callsFile) => {
		const calls = runSetup(scratch, callsFile, ["owner/repo", "v*"]);
		assert.deepEqual(
			calls.map((call) => call.args),
			[
				["api", "repos/owner/repo/environments/npm-release", "-X", "PUT", "--input", "-"],
				[
					"api",
					"repos/owner/repo/environments/npm-release/deployment-branch-policies",
					"--jq",
					".branch_policies[].name",
				],
				[
					"api",
					"repos/owner/repo/rulesets",
					"--jq",
					'[.[] | select(.name == "release-tags-admin-only" and .source_type == "Repository")][0].id // empty',
				],
				["api", "repos/owner/repo/rulesets", "-X", "POST", "--input", "-"],
			],
		);
		assert.deepEqual(JSON.parse(calls[0]?.input ?? ""), {
			can_admins_bypass: false,
			wait_timer: 0,
			reviewers: [],
			deployment_branch_policy: {
				protected_branches: false,
				custom_branch_policies: true,
			},
		});
		assert.deepEqual(JSON.parse(calls[3]?.input ?? ""), {
			name: "release-tags-admin-only",
			target: "tag",
			enforcement: "active",
			conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
			rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
			bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
		});
	});
});

test("release setup rejects malicious repository and tag inputs before gh", () => {
	const maliciousInputs = [
		["owner/repo\n-X DELETE", "v*"],
		["owner/repo", 'v*"],"exclude":["refs/tags/**'],
		["owner/repo", "v*", "extra"],
	];
	for (const args of maliciousInputs) {
		withFakeGh((scratch, callsFile) => {
			const result = spawnSync("/bin/bash", [SETUP_SCRIPT, ...args], {
				env: {
					...process.env,
					GH_CALLS: callsFile,
					PATH: `${scratch}${path.delimiter}${process.env.PATH ?? ""}`,
				},
				encoding: "utf8",
			});
			assert.notEqual(result.status, 0);
			assert.equal(existsSync(callsFile) ? readFileSync(callsFile, "utf8") : "", "");
		});
	}
});

test("release setup fails clearly when gh is unavailable", () => {
	const scratch = mkdtempSync(path.join(tmpdir(), "pi-stash-release-missing-gh-"));
	try {
		const result = spawnSync("/bin/bash", [SETUP_SCRIPT, "owner/repo", "v*"], {
			env: { ...process.env, PATH: scratch },
			encoding: "utf8",
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /gh is required/u);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});
