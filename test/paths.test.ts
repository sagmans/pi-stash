import { strict as assert } from "node:assert";
import test from "node:test";

import {
	defaultStashBaseDir,
	resolveLegacyStashPaths,
	resolveStashPaths,
	sanitizeCwd,
	sanitizeLegacyCwd,
	scopeLabel,
} from "../src/paths.ts";

const MAX_STORAGE_KEY_BYTES = 200;

test("sanitizeCwd flattens absolute POSIX paths", () => {
	assert.equal(sanitizeCwd("/Users/me/repo"), "v2--Users--me--repo");
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

test("sanitizeCwd limits long and multibyte keys to 200 UTF-8 bytes", () => {
	for (const cwd of [`/${"segment-".repeat(40)}`, `/a/${"界".repeat(100)}`]) {
		const sanitized = sanitizeCwd(cwd);
		assert.ok(Buffer.byteLength(sanitized) <= MAX_STORAGE_KEY_BYTES);
		assert.ok(sanitized.startsWith("v2--"));
		assert.notEqual(sanitized, sanitizeCwd(`${cwd}-x`));
	}
});

test("defaultStashBaseDir lives under Pi's configured agent directory", () => {
	assert.equal(defaultStashBaseDir("/profiles/work"), "/profiles/work/pi-stash");
});

test("scopeLabel preserves POSIX root, home, nested, sibling, and missing-home boundaries", () => {
	assert.equal(scopeLabel("/", "/Users/me"), "/");
	assert.equal(scopeLabel("/Users/me", "/Users/me"), "~");
	assert.equal(scopeLabel("/Users/me/repo", "/Users/me"), "~/repo");
	assert.equal(scopeLabel("/Users/me/a/b/c/d", "/Users/me"), "…/b/c/d");
	assert.equal(scopeLabel("/Users/me-too/repo", "/Users/me"), "/Users/me-too/repo");
	assert.equal(scopeLabel("/srv/repo", "/Users/me"), "/srv/repo");
	assert.equal(scopeLabel("/srv/repo", undefined), "/srv/repo");
});

test("resolveStashPaths derives stash file and per-entry asset dir", () => {
	const paths = resolveStashPaths("/Users/me/repo", "/tmp/base");
	assert.equal(paths.sanitized, "v2--Users--me--repo");
	assert.equal(paths.stashFile, "/tmp/base/v2--Users--me--repo.json");
	assert.equal(paths.assetDir("abc"), "/tmp/base/v2--Users--me--repo-assets/abc");
	assert.throws(() => paths.assetDir("../escape"), /invalid stash entry id/);
});

test("sanitizeLegacyCwd reproduces the historical unprefixed key byte-for-byte", () => {
	assert.equal(sanitizeLegacyCwd("/Users/me/repo"), "--Users--me--repo");
	assert.equal(sanitizeLegacyCwd("/Users/me/repo/"), "--Users--me--repo");
	// The historical writer treated backslashes as separators and never
	// escaped segments; discovery must not reinterpret either choice.
	assert.equal(sanitizeLegacyCwd("C:\\dev\\repo"), "--C:--dev--repo");
	assert.equal(sanitizeLegacyCwd("/a--b"), "--a--b");
});

test("sanitizeLegacyCwd limits long keys with the historical hash suffix", () => {
	const longCwd = `/${"segment-".repeat(40)}`;
	const sanitized = sanitizeLegacyCwd(longCwd);
	assert.ok(sanitized.length <= 200);
	assert.ok(sanitized.startsWith("--segment"));
	assert.notEqual(sanitized, sanitizeLegacyCwd(`${longCwd}-x`));
});

test("resolveLegacyStashPaths derives the historical stash file and asset root", () => {
	const paths = resolveLegacyStashPaths("/Users/me/repo", "/tmp/base");
	assert.equal(paths.stashFile, "/tmp/base/--Users--me--repo.json");
	assert.equal(paths.assetDir("abc"), "/tmp/base/--Users--me--repo-assets/abc");
	assert.throws(() => paths.assetDir("../escape"), /invalid stash entry id/);
});
