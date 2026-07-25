import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const VALIDATOR = path.resolve("scripts/release/validate-waiver.mjs");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OWNER = "release-owner";
const SCOPE = "gate-4";

function validWaiver(): Record<string, unknown> {
	const now = Date.now();
	return {
		schemaVersion: 1,
		candidateSha: SHA,
		scope: SCOPE,
		owner: OWNER,
		reason: "Temporary infrastructure outage blocks the packaged runtime smoke.",
		evidence: ["https://github.com/sagmans/pi-stash/actions/runs/123"],
		createdAt: new Date(now - 60_000).toISOString(),
		expiresAt: new Date(now + 3_600_000).toISOString(),
	};
}

function withWaiver(
	value: unknown,
	run: (file: string) => void,
	contents = JSON.stringify(value),
): void {
	const scratch = mkdtempSync(path.join(tmpdir(), "pi-stash-waiver-test-"));
	try {
		const file = path.join(scratch, "waiver.json");
		writeFileSync(file, contents);
		run(file);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

test("release waiver validator accepts one narrow SHA-bound record", () => {
	withWaiver(validWaiver(), (file) => {
		const output = execFileSync(process.execPath, [VALIDATOR, file, SHA, OWNER, SCOPE], {
			encoding: "utf8",
		});
		assert.equal(output, `valid release waiver: ${SHA} ${SCOPE}\n`);
	});
});

test("release waiver validator rejects malformed, expired, unknown, and broad records", () => {
	const invalidRecords: Array<[string, unknown, string?]> = [
		["malformed JSON", validWaiver(), "{"],
		["unknown field", { ...validWaiver(), bypass: true }],
		["broad scope", { ...validWaiver(), scope: "all" }],
		[
			"expired",
			{
				...validWaiver(),
				createdAt: new Date(Date.now() - 7_200_000).toISOString(),
				expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
			},
		],
		["wrong SHA", { ...validWaiver(), candidateSha: "f".repeat(40) }],
		["wrong owner", { ...validWaiver(), owner: "other-owner" }],
		["missing evidence", { ...validWaiver(), evidence: [] }],
	];

	for (const [name, record, contents] of invalidRecords) {
		withWaiver(
			record,
			(file) => {
				const result = spawnSync(process.execPath, [VALIDATOR, file, SHA, OWNER, SCOPE], {
					encoding: "utf8",
				});
				assert.notEqual(result.status, 0, name);
				assert.match(result.stderr, /^invalid release waiver:/u, name);
			},
			contents,
		);
	}
});

test("release waiver validator fails closed when its record is unavailable", () => {
	const result = spawnSync(
		process.execPath,
		[VALIDATOR, "/missing/release-waiver.json", SHA, OWNER, SCOPE],
		{ encoding: "utf8" },
	);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /^invalid release waiver:/u);
});
