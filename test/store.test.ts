import { strict as assert } from "node:assert";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { resolveStashPaths } from "../src/paths.ts";
import { loadStashStore, STASH_SCHEMA_VERSION } from "../src/store.ts";

const STALE_LOCK_AGE_MS = 31_000;
const TEST_LOCK_TOKEN = "test-lock-owner";
const DEAD_PROCESS_ID = 2_147_483_647;
const FUTURE_SCHEMA_VERSION = STASH_SCHEMA_VERSION + 1;

let baseDir: string;
let counter = 0;

beforeEach(() => {
	baseDir = mkdtempSync(path.join(tmpdir(), "pi-stash-test-"));
	counter = 0;
});

afterEach(() => {
	rmSync(baseDir, { recursive: true, force: true });
});

function clock(): number {
	counter += 1000;
	return counter;
}

function storeFor(cwd = "/repo") {
	return loadStashStore(resolveStashPaths(cwd, baseDir), clock);
}

test("loads empty when no stash file exists", async () => {
	const store = await storeFor();
	assert.equal(store.entryCount, 0);
	assert.deepEqual([...store.entries], []);
});

test("add places newest entry at index 0 (LIFO)", async () => {
	const store = await storeFor();
	await store.add({ text: "first" });
	await store.add({ text: "second" });
	assert.equal(store.entryCount, 2);
	assert.equal(store.entries[0]?.text, "second");
	assert.equal(store.entries[1]?.text, "first");
});

test("add honors caller-supplied id and optional fields", async () => {
	const store = await storeFor();
	const entry = await store.add({ id: "fixed-id", text: "x", message: "m", assetCount: 3 });
	assert.equal(entry.id, "fixed-id");
	assert.equal(entry.message, "m");
	assert.equal(entry.assetCount, 3);
});

test("add rejects path-bearing entry ids", async () => {
	const store = await storeFor();
	await assert.rejects(() => store.add({ id: "../escape", text: "x" }), /invalid stash entry id/);
	assert.equal(store.entryCount, 0);
});

test("add drops empty message and zero assetCount", async () => {
	const store = await storeFor();
	const entry = await store.add({ text: "x", message: "   ", assetCount: 0 });
	assert.equal(entry.message, undefined);
	assert.equal(entry.assetCount, undefined);
});

test("pop defaults to newest and removes it", async () => {
	const store = await storeFor();
	await store.add({ text: "first" });
	await store.add({ text: "second" });
	const popped = await store.pop(undefined);
	assert.equal(popped?.entry.text, "second");
	assert.equal(store.entryCount, 1);
	assert.equal(store.entries[0]?.text, "first");
});

test("pop resolves by index and by id", async () => {
	const store = await storeFor();
	await store.add({ text: "a" });
	const b = await store.add({ text: "b" }); // entries: [b, a]
	assert.equal((await store.pop(b.id))?.entry.text, "b");
	assert.equal((await store.pop("0"))?.entry.text, "a");
	assert.equal(store.entryCount, 0);
});

test("pop returns undefined for unknown selector", async () => {
	const store = await storeFor();
	await store.add({ text: "a" });
	assert.equal(await store.pop("nope"), undefined);
	assert.equal(store.entryCount, 1);
});

test("drop removes and returns the entry", async () => {
	const store = await storeFor();
	await store.add({ text: "a" });
	const dropped = await store.drop(undefined);
	assert.equal(dropped?.entry.text, "a");
	assert.equal(store.entryCount, 0);
});

test("clear empties the store and returns removed ids", async () => {
	const store = await storeFor();
	await store.add({ text: "a" });
	await store.add({ text: "b" });
	const ids = await store.clear();
	assert.equal(ids.length, 2);
	assert.equal(store.entryCount, 0);
});

test("clear reloads entries added by another store before returning asset ids", async () => {
	const paths = resolveStashPaths("/repo", baseDir);
	const first = await loadStashStore(paths, clock);
	const older = await first.add({ text: "older" });
	const stale = await loadStashStore(paths, clock);
	const newer = await first.add({ text: "newer" });

	const ids = await stale.clear();

	assert.deepEqual(new Set(ids), new Set([older.id, newer.id]));
	assert.equal(stale.entryCount, 0);
});

test("writes persist across store instances", async () => {
	const paths = resolveStashPaths("/repo", baseDir);
	const store = await loadStashStore(paths, clock);
	await store.add({ text: "persisted" });
	const reopened = await loadStashStore(paths, clock);
	assert.equal(reopened.entryCount, 1);
	assert.equal(reopened.entries[0]?.text, "persisted");
});

test("stash file for another cwd key is quarantined", async () => {
	const paths = resolveStashPaths("/repo", baseDir);
	writeFileSync(
		paths.stashFile,
		JSON.stringify({
			schemaVersion: 1,
			cwd: "--other",
			createdAt: 1,
			updatedAt: 1,
			entries: [],
		}),
	);

	const store = await loadStashStore(paths, clock);

	assert.equal(store.entryCount, 0);
	assert.ok(readdirSync(baseDir).some((name) => name.includes(".corrupt-")));
});

test("unsupported future schema remains in place and blocks writes", async () => {
	const paths = resolveStashPaths("/repo", baseDir);
	writeFileSync(
		paths.stashFile,
		JSON.stringify({
			schemaVersion: FUTURE_SCHEMA_VERSION,
			cwd: paths.sanitized,
			createdAt: 1,
			updatedAt: 1,
			entries: [],
		}),
	);
	const store = await loadStashStore(paths, clock);

	await assert.rejects(
		() => store.add({ text: "must not overwrite" }),
		/unsupported stash schema version/,
	);
	assert.equal(
		JSON.parse(readFileSync(paths.stashFile, "utf8")).schemaVersion,
		FUTURE_SCHEMA_VERSION,
	);
	assert.equal(
		readdirSync(baseDir).some((name) => name.includes(".corrupt-")),
		false,
	);
});

test("corrupt stash file is quarantined and treated as empty", async () => {
	const paths = resolveStashPaths("/repo", baseDir);
	writeFileSync(paths.stashFile, "{ not valid json ");
	const store = await loadStashStore(paths, clock);
	assert.equal(store.entryCount, 0);
	// The bad file was moved aside, not destroyed.
	const quarantined = readdirSync(baseDir).some((name) => name.includes(".corrupt-"));
	assert.ok(quarantined, "expected a quarantine file");
});

test("mutation after corruption does not resurrect cached drafts", async () => {
	const paths = resolveStashPaths("/repo", baseDir);
	const store = await loadStashStore(paths, clock);
	await store.add({ text: "must stay quarantined" });
	writeFileSync(paths.stashFile, "{ broken json");

	await store.add({ text: "fresh" });

	const reopened = await loadStashStore(paths, clock);
	assert.deepEqual(
		reopened.entries.map((entry) => entry.text),
		["fresh"],
	);
});

test("does not reclaim a stale-looking lock owned by a live process", async () => {
	const paths = resolveStashPaths("/live-lock", baseDir);
	const store = await loadStashStore(paths, clock);
	const lockPath = `${paths.stashFile}.lock`;
	mkdirSync(lockPath);
	writeFileSync(
		path.join(lockPath, "owner.json"),
		JSON.stringify({
			pid: process.pid,
			host: hostname(),
			token: TEST_LOCK_TOKEN,
			createdAt: new Date().toISOString(),
		}),
	);
	const staleTime = new Date(Date.now() - STALE_LOCK_AGE_MS);
	utimesSync(lockPath, staleTime, staleTime);

	await assert.rejects(() => store.add({ text: "blocked" }), /timed out waiting/);
});

test("reclaims a stale lock owned by a dead local process", async () => {
	const paths = resolveStashPaths("/dead-lock", baseDir);
	const store = await loadStashStore(paths, clock);
	const lockPath = `${paths.stashFile}.lock`;
	mkdirSync(lockPath);
	writeFileSync(
		path.join(lockPath, "owner.json"),
		JSON.stringify({
			pid: DEAD_PROCESS_ID,
			host: hostname(),
			token: TEST_LOCK_TOKEN,
			createdAt: new Date().toISOString(),
		}),
	);
	const staleTime = new Date(Date.now() - STALE_LOCK_AGE_MS);
	utimesSync(lockPath, staleTime, staleTime);

	await store.add({ text: "recovered" });

	assert.equal(store.entries[0]?.text, "recovered");
});

test("stash file is written with tight 0o600 permissions", async () => {
	const store = await storeFor("/perm");
	await store.add({ text: "x" });
	const paths = resolveStashPaths("/perm", baseDir);
	const raw = readFileSync(paths.stashFile, "utf8");
	assert.ok(raw.includes('"entries"'));
	assert.equal(JSON.parse(raw).entries.length, 1);
	assert.equal(statSync(paths.stashFile).mode & 0o777, 0o600);
	assert.equal(statSync(path.dirname(paths.stashFile)).mode & 0o777, 0o700);
});
