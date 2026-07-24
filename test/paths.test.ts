import { strict as assert } from "node:assert";
import test from "node:test";

import { defaultStashBaseDir, resolveStashPaths, sanitizeCwd } from "../src/paths.ts";

test("sanitizeCwd flattens absolute posix path with double dash", () => {
	assert.equal(sanitizeCwd("/Users/me/repo"), "v2--Users--me--repo");
});

test("sanitizeCwd drops trailing separators", () => {
	assert.equal(sanitizeCwd("/Users/me/repo/"), "v2--Users--me--repo");
});

test("sanitizeCwd escapes literal backslashes on supported POSIX systems", () => {
	assert.equal(sanitizeCwd("C:\\dev\\repo"), "v2--C:%5Cdev%5Crepo");
	assert.notEqual(sanitizeCwd("/a/b"), sanitizeCwd("/a\\b"));
});

test("sanitizeCwd produces distinct keys for distinct cwds", () => {
	assert.notEqual(sanitizeCwd("/a/b"), sanitizeCwd("/a/c"));
	assert.notEqual(sanitizeCwd("/a/b"), sanitizeCwd("/a--b"));
	assert.notEqual(sanitizeCwd("/a%2D%2Db"), sanitizeCwd("/a--b"));
});

test("sanitizeCwd stays within maxLength by hashing the overflow", () => {
	const cwd = `/${"segment-".repeat(40)}`;
	const sanitized = sanitizeCwd(cwd, { maxLength: 60 });
	assert.ok(
		Buffer.byteLength(sanitized) <= 60,
		`expected <= 60 bytes, got ${Buffer.byteLength(sanitized)}`,
	);
	assert.ok(sanitized.startsWith("v2--"));
	// Two distinct long paths must not collide even when truncated.
	assert.notEqual(sanitized, sanitizeCwd(`${cwd}-x`, { maxLength: 60 }));
});

test("sanitizeCwd limits multibyte names by UTF-8 bytes", () => {
	const sanitized = sanitizeCwd(`/a/${"界".repeat(40)}`, { maxLength: 60 });
	assert.ok(
		Buffer.byteLength(sanitized) <= 60,
		`expected <= 60 bytes, got ${Buffer.byteLength(sanitized)}`,
	);
});

test("sanitizeCwd rejects a limit too short for a collision-resistant key", () => {
	assert.throws(() => sanitizeCwd("/repo", { maxLength: 21 }), /at least 22 bytes/);
});

test("defaultStashBaseDir lives under Pi's configured agent directory", () => {
	assert.equal(defaultStashBaseDir("/profiles/work"), "/profiles/work/pi-stash");
});

test("resolveStashPaths derives stash file and per-entry asset dir", () => {
	const paths = resolveStashPaths("/Users/me/repo", "/tmp/base");
	assert.equal(paths.sanitized, "v2--Users--me--repo");
	assert.equal(paths.stashFile, "/tmp/base/v2--Users--me--repo.json");
	assert.equal(paths.assetDir("abc"), "/tmp/base/v2--Users--me--repo-assets/abc");
	assert.throws(() => paths.assetDir("../escape"), /invalid stash entry id/);
});
