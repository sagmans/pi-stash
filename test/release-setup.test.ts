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
  if (endpoint === "users/reviewer") process.stdout.write("42\\n");
  else if (endpoint.endsWith("deployment-branch-policies") && args.includes("--jq")) {
    process.stdout.write(process.env.GH_EXISTING_POLICY ?? "");
  }
});
`;

type GhCall = { args: string[]; input: string };

function withFakeGh(run: (scratch: string, callsFile: string) => void): void {
	const scratch = mkdtempSync(path.join(tmpdir(), "pi-stash-release-test-"));
	try {
		const fakeGh = path.join(scratch, "gh");
		const callsFile = path.join(scratch, "gh-calls.jsonl");
		writeFileSync(fakeGh, FAKE_GH);
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
		const calls = runSetup(scratch, callsFile, ["owner/repo", "reviewer", "v*"]);
		assert.deepEqual(
			calls.map((call) => call.args),
			[
				["api", "users/reviewer", "--jq", ".id"],
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
		assert.deepEqual(JSON.parse(calls[1]?.input ?? ""), {
			can_admins_bypass: false,
			reviewers: [{ type: "User", id: 42 }],
			deployment_branch_policy: {
				protected_branches: false,
				custom_branch_policies: true,
			},
		});
		assert.deepEqual(JSON.parse(calls[4]?.input ?? ""), {
			name: "release-tags-admin-only",
			target: "tag",
			enforcement: "active",
			conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
			rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
			bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
		});
	});
});

test("release setup rejects malicious repository, reviewer, and tag inputs before gh", () => {
	const maliciousInputs = [
		["owner/repo\n-X DELETE", "reviewer", "v*"],
		["owner/repo", 'reviewer"}', "v*"],
		["owner/repo", "reviewer", 'v*"],"exclude":["refs/tags/**'],
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
		const result = spawnSync("/bin/bash", [SETUP_SCRIPT, "owner/repo", "reviewer", "v*"], {
			env: { ...process.env, PATH: scratch },
			encoding: "utf8",
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /gh is required/u);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});
