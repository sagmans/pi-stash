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

const CURRENT_SCHEMA_VERSION = 2;
const DEAD_PROCESS_ID = 2_147_483_647;
const FRACTIONAL_ASSET_COUNT = 0.5;
const FUTURE_SCHEMA_VERSION = STASH_SCHEMA_VERSION + 1;
const LEGACY_ENTRY_ID = "legacy-entry";
const LEGACY_SCHEMA_VERSION = 1;
const STALE_LOCK_AGE_MS = 31_000;
const TEST_LOCK_TOKEN = "test-lock-owner";

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

function writeLegacyStash(
	paths: ReturnType<typeof resolveStashPaths>,
	overrides: Record<string, unknown> = {},
): void {
	writeFileSync(
		paths.stashFile,
		JSON.stringify({
			schemaVersion: LEGACY_SCHEMA_VERSION,
			cwd: paths.sanitized,
			createdAt: 1,
			updatedAt: 2,
			entries: [],
			...overrides,
		}),
	);
}

test("loads empty when no stash file exists", async () => {
	const store = await storeFor();
	assert.equal(store.entryCount, 0);
	assert.deepEqual([...store.entries], []);
});

test("add places uniquely identified entries newest-first", async () => {
	const store = await storeFor();
	const first = await store.add({ text: "first" });
	const second = await store.add({ text: "second" });
	assert.equal(store.entryCount, 2);
	assert.notEqual(first.id, second.id);
	assert.equal(store.entries[0]?.text, "second");
	assert.equal(store.entries[1]?.text, "first");
});

test("add rejects an id already owned by an active entry", async () => {
	const store = await storeFor();
	await store.add({ id: "fixed-id", text: "first" });

	await assert.rejects(() => store.add({ id: "fixed-id", text: "second" }), /duplicate stash id/);
	assert.equal(store.entryCount, 1);
});

test("add rejects cleanup ownership for an active entry", async () => {
	const store = await storeFor();
	await store.add({ id: "active-id", text: "first" });

	await assert.rejects(
		() => store.add({ id: "new-id", text: "second", cleanupIds: ["active-id"] }),
		/active stash id queued for cleanup/,
	);
	assert.equal(store.entryCount, 1);
});

test("add rejects an id still pending cleanup", async () => {
	const store = await storeFor();
	await store.add({ id: "pending-id", text: "first" });
	await store.drop("pending-id");

	await assert.rejects(
		() => store.add({ id: "pending-id", text: "second" }),
		/stash id pending asset cleanup/,
	);
	assert.equal(store.entryCount, 0);
});

test("add honors caller-supplied id and atomically queues transferred assets", async () => {
	const store = await storeFor();
	const entry = await store.add({
		id: "fixed-id",
		text: "x",
		message: "m",
		assetCount: 3,
		cleanupIds: ["restored-entry"],
	});
	assert.equal(entry.id, "fixed-id");
	assert.equal(entry.message, "m");
	assert.equal(entry.assetCount, 3);
	assert.deepEqual(store.pendingAssetCleanupIds, ["restored-entry"]);
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

test("add rejects unsafe asset counts", async () => {
	const store = await storeFor();
	await assert.rejects(() => store.add({ text: "x", assetCount: -1 }), /invalid asset count/);
	await assert.rejects(
		() => store.add({ text: "x", assetCount: FRACTIONAL_ASSET_COUNT }),
		/invalid asset count/,
	);
	assert.equal(store.entryCount, 0);
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

test("drop removes the entry and durably queues its asset cleanup", async () => {
	const paths = resolveStashPaths("/repo", baseDir);
	const store = await loadStashStore(paths, clock);
	const entry = await store.add({ text: "a" });
	const dropped = await store.drop(undefined);
	assert.equal(dropped?.entry.text, "a");
	assert.equal(store.entryCount, 0);
	assert.deepEqual(store.pendingAssetCleanupIds, [entry.id]);
	assert.deepEqual((await loadStashStore(paths, clock)).pendingAssetCleanupIds, [entry.id]);
});

test("completeAssetCleanup acknowledges only the completed id", async () => {
	const store = await storeFor();
	const first = await store.add({ text: "a" });
	const second = await store.add({ text: "b" });
	await store.clear();

	await store.completeAssetCleanup(first.id);

	assert.deepEqual(store.pendingAssetCleanupIds, [second.id]);
});

test("clear empties the store and returns removed ids", async () => {
	const store = await storeFor();
	await store.add({ text: "a" });
	await store.add({ text: "b" });
	const ids = await store.clear();
	assert.equal(ids.length, 2);
	assert.equal(store.entryCount, 0);
	assert.deepEqual(new Set(store.pendingAssetCleanupIds), new Set(ids));
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

test("migrates populated schema v1 state without losing owned assets", async () => {
	const paths = resolveStashPaths("/legacy-populated", baseDir);
	mkdirSync(paths.assetDir(LEGACY_ENTRY_ID), { recursive: true });
	const assetPath = path.join(paths.assetDir(LEGACY_ENTRY_ID), "00-image.png");
	writeFileSync(assetPath, "synthetic-image");
	writeLegacyStash(paths, {
		entries: [
			{
				id: LEGACY_ENTRY_ID,
				text: `draft ${assetPath}`,
				createdAt: 1,
				message: "legacy note",
				assetCount: 1,
			},
		],
		pendingAssetCleanup: [LEGACY_ENTRY_ID, "stale-assets", "stale-assets"],
	});

	const store = await loadStashStore(paths, clock);
	const migrated = JSON.parse(readFileSync(paths.stashFile, "utf8"));

	assert.equal(STASH_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION);
	assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
	assert.equal(store.entries[0]?.id, LEGACY_ENTRY_ID);
	assert.equal(store.entries[0]?.message, "legacy note");
	assert.equal(store.entries[0]?.assetCount, 1);
	assert.deepEqual(store.pendingAssetCleanupIds, ["stale-assets"]);
	assert.equal(readFileSync(assetPath, "utf8"), "synthetic-image");
});

test("migrates empty schema v1 state with missing cleanup metadata", async () => {
	const paths = resolveStashPaths("/legacy-empty", baseDir);
	writeLegacyStash(paths);

	const store = await loadStashStore(paths, clock);
	const migrated = JSON.parse(readFileSync(paths.stashFile, "utf8"));

	assert.equal(store.entryCount, 0);
	assert.deepEqual(store.pendingAssetCleanupIds, []);
	assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
	assert.deepEqual(migrated.pendingAssetCleanup, []);
});

test("retries schema v1 migration after an interrupted write", async () => {
	const paths = resolveStashPaths("/legacy-interrupted", baseDir);
	writeLegacyStash(paths, {
		entries: [{ id: LEGACY_ENTRY_ID, text: "preserved", createdAt: 1 }],
	});

	await assert.rejects(
		() =>
			loadStashStore(paths, clock, async () => {
				throw new Error("migration interrupted");
			}),
		/migration interrupted/,
	);
	assert.equal(
		JSON.parse(readFileSync(paths.stashFile, "utf8")).schemaVersion,
		LEGACY_SCHEMA_VERSION,
	);

	const recovered = await loadStashStore(paths, clock);
	assert.equal(recovered.entries[0]?.text, "preserved");
	assert.equal(
		JSON.parse(readFileSync(paths.stashFile, "utf8")).schemaVersion,
		CURRENT_SCHEMA_VERSION,
	);
});

test("schema v1 migration is idempotent after commit", async () => {
	const paths = resolveStashPaths("/legacy-idempotent", baseDir);
	writeLegacyStash(paths, {
		entries: [{ id: LEGACY_ENTRY_ID, text: "preserved", createdAt: 1 }],
	});

	await loadStashStore(paths, clock);
	const firstMigration = readFileSync(paths.stashFile, "utf8");
	await loadStashStore(paths, clock);

	assert.equal(readFileSync(paths.stashFile, "utf8"), firstMigration);
});

test("rejects schema v1 state with duplicate entry identifiers", async () => {
	const paths = resolveStashPaths("/legacy-duplicates", baseDir);
	writeLegacyStash(paths, {
		entries: [
			{ id: LEGACY_ENTRY_ID, text: "first", createdAt: 1 },
			{ id: LEGACY_ENTRY_ID, text: "second", createdAt: 2 },
		],
	});

	const store = await loadStashStore(paths, clock);

	assert.equal(store.entryCount, 0);
	assert.ok(readdirSync(baseDir).some((name) => name.includes(".corrupt-")));
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

test("reclaims an abandoned stale lock-reclamation guard", async () => {
	const paths = resolveStashPaths("/abandoned-reclaim", baseDir);
	const store = await loadStashStore(paths, clock);
	const lockPath = `${paths.stashFile}.lock`;
	const reclaimPath = `${lockPath}.reclaim`;
	for (const directory of [lockPath, reclaimPath]) {
		mkdirSync(directory);
		writeFileSync(
			path.join(directory, "owner.json"),
			JSON.stringify({
				pid: DEAD_PROCESS_ID,
				host: hostname(),
				token: TEST_LOCK_TOKEN,
				createdAt: new Date().toISOString(),
			}),
		);
		const staleTime = new Date(Date.now() - STALE_LOCK_AGE_MS);
		utimesSync(directory, staleTime, staleTime);
	}

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
