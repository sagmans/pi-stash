import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { pathToFileURL } from "node:url";

import { CommittedMutationError } from "../src/lock.ts";
import { resolveStashPaths } from "../src/paths.ts";
import { readProcessGeneration } from "../src/process-owner.ts";
import {
	loadStashStore,
	STASH_SCHEMA_VERSION,
	UnsupportedStashSchemaError,
	writeStashFile,
} from "../src/store.ts";

const DEAD_PROCESS_ID = 2_147_483_647;
const FRACTIONAL_ASSET_COUNT = 0.5;
const FUTURE_SCHEMA_VERSION = STASH_SCHEMA_VERSION + 1;
const LEGACY_ENTRY_ID = "legacy-entry";
const LEGACY_SCHEMA_VERSION = 1;
const QUARANTINE_TIMESTAMP = 12_345;
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

function poisonLockOwner(paths: ReturnType<typeof resolveStashPaths>): void {
	const lockPath = `${paths.stashFile}.lock`;
	const ownerPath = path.join(lockPath, "owner.json");
	const targetPath = `${lockPath}.poison`;
	rmSync(ownerPath, { force: true });
	writeFileSync(targetPath, "not a lock owner");
	symlinkSync(targetPath, ownerPath);
}

function removePoisonedLock(paths: ReturnType<typeof resolveStashPaths>): void {
	rmSync(`${paths.stashFile}.lock`, { recursive: true, force: true });
	rmSync(`${paths.stashFile}.lock.poison`, { force: true });
}

test("loads empty when no stash file exists", async () => {
	const store = await storeFor();
	assert.equal(store.entryCount, 0);
	assert.deepEqual([...store.entries], []);
});

test("rejects a symbolic-link storage root without touching its target", async () => {
	const target = path.join(baseDir, "target");
	const linkedRoot = path.join(baseDir, "linked-root");
	mkdirSync(target);
	symlinkSync(target, linkedRoot, "dir");
	const paths = resolveStashPaths("/linked-root", linkedRoot);

	await assert.rejects(() => loadStashStore(paths, clock), /storage directory.*symbolic link/);
	assert.deepEqual(readdirSync(target), []);
});

test("rejects a stash-file symbolic link without changing its target", async () => {
	const paths = resolveStashPaths("/linked-file", baseDir);
	const target = path.join(baseDir, "target.json");
	const targetText = JSON.stringify({
		schemaVersion: STASH_SCHEMA_VERSION,
		cwd: paths.sanitized,
		createdAt: 1,
		updatedAt: 1,
		entries: [],
		pendingAssetCleanup: [],
	});
	writeFileSync(target, targetText);
	symlinkSync(target, paths.stashFile);

	await assert.rejects(() => loadStashStore(paths, clock), /stash file.*symbolic link/);
	assert.equal(readFileSync(target, "utf8"), targetText);
});

test("rejects an unexpected stash-file type", async () => {
	const paths = resolveStashPaths("/directory-file", baseDir);
	mkdirSync(paths.stashFile);

	await assert.rejects(() => loadStashStore(paths, clock), /stash file.*regular file/);
	assert.equal(statSync(paths.stashFile).isDirectory(), true);
});

test("rejects a storage root not owned by the current user", {
	skip: !process.getuid,
}, async (t) => {
	const currentUid = process.getuid?.();
	assert.notEqual(currentUid, undefined);
	const processWithUid = process as typeof process & { getuid(): number };
	t.mock.method(processWithUid, "getuid", () => (currentUid ?? 0) + 1);

	await assert.rejects(() => storeFor("/foreign-owner"), /storage directory.*current user/);
});

test("repairs insecure storage-root and stash-file permissions", async () => {
	const paths = resolveStashPaths("/repair-permissions", baseDir);
	writeFileSync(
		paths.stashFile,
		JSON.stringify({
			schemaVersion: STASH_SCHEMA_VERSION,
			cwd: paths.sanitized,
			createdAt: 1,
			updatedAt: 1,
			entries: [],
			pendingAssetCleanup: [],
		}),
	);
	chmodSync(baseDir, 0o777);
	chmodSync(paths.stashFile, 0o666);

	await loadStashStore(paths, clock);

	assert.equal(statSync(baseDir).mode & 0o777, 0o700);
	assert.equal(statSync(paths.stashFile).mode & 0o777, 0o600);
});

test("quarantine preserves a colliding recovery file", async (t) => {
	const paths = resolveStashPaths("/quarantine-collision", baseDir);
	const collisionPath = `${paths.stashFile}.corrupt-${QUARANTINE_TIMESTAMP}`;
	writeFileSync(paths.stashFile, "{ corrupt stash");
	writeFileSync(collisionPath, "existing evidence");
	t.mock.method(Date, "now", () => QUARANTINE_TIMESTAMP);

	const store = await loadStashStore(paths, clock);

	assert.equal(store.entryCount, 0);
	assert.equal(readFileSync(collisionPath, "utf8"), "existing evidence");
	assert.equal(readFileSync(`${collisionPath}-1`, "utf8"), "{ corrupt stash");
	assert.equal(existsSync(paths.stashFile), false);
});

test("rejects a symbolic-link lock without touching its target", async () => {
	const paths = resolveStashPaths("/linked-lock", baseDir);
	const target = path.join(baseDir, "lock-target");
	const marker = path.join(target, "marker");
	mkdirSync(target);
	writeFileSync(marker, "keep");
	symlinkSync(target, `${paths.stashFile}.lock`, "dir");

	await assert.rejects(() => loadStashStore(paths, clock), /stash lock.*symbolic link/);
	assert.equal(readFileSync(marker, "utf8"), "keep");
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
		label: "m",
		assetCount: 3,
		cleanupIds: ["restored-entry"],
	});
	assert.equal(entry.id, "fixed-id");
	assert.equal(entry.label, "m");
	assert.equal(entry.assetCount, 3);
	assert.deepEqual(store.pendingAssetCleanupIds, ["restored-entry"]);
});

test("add rejects path-bearing entry ids", async () => {
	const store = await storeFor();
	await assert.rejects(() => store.add({ id: "../escape", text: "x" }), /invalid stash entry id/);
	assert.equal(store.entryCount, 0);
});

test("add drops empty label and zero assetCount", async () => {
	const store = await storeFor();
	const entry = await store.add({ text: "x", label: "   ", assetCount: 0 });
	assert.equal(entry.label, undefined);
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

test("add reports its committed result when lock release fails", async () => {
	const paths = resolveStashPaths("/committed-add", baseDir);
	const store = await loadStashStore(paths, clock, async (filePath, file) => {
		writeFileSync(filePath, JSON.stringify(file));
		poisonLockOwner(paths);
	});
	let resultId: string | undefined;

	await assert.rejects(
		() => store.add({ text: "committed" }),
		(error: unknown) => {
			if (!(error instanceof CommittedMutationError)) return false;
			resultId = (error.result as { id?: string }).id;
			return (
				typeof resultId === "string" &&
				error.failures.length === 1 &&
				error.failures[0]?.phase === "lock-release"
			);
		},
	);
	removePoisonedLock(paths);

	const reopened = await loadStashStore(paths, clock);
	assert.equal(reopened.entryCount, 1);
	assert.equal(reopened.entries[0]?.id, resultId);
	assert.equal(reopened.entries[0]?.text, "committed");
});

test("add cannot release a replacement lock generation", async () => {
	const paths = resolveStashPaths("/replacement-lock", baseDir);
	const lockPath = `${paths.stashFile}.lock`;
	const store = await loadStashStore(paths, clock, async (filePath, file) => {
		writeFileSync(filePath, JSON.stringify(file));
		writeFileSync(
			path.join(lockPath, "owner.json"),
			JSON.stringify({
				pid: process.pid,
				host: hostname(),
				token: "replacement-token",
				generation: await readProcessGeneration(process.pid),
				createdAt: new Date().toISOString(),
			}),
		);
	});

	await assert.rejects(
		() => store.add({ text: "committed under original lock" }),
		(error: unknown) =>
			error instanceof CommittedMutationError &&
			error.failures.some(
				({ phase, error: failure }) =>
					phase === "lock-release" && String(failure).includes("generation changed"),
			),
	);
	assert.equal(existsSync(lockPath), true);
	rmSync(lockPath, { recursive: true, force: true });
	assert.equal((await loadStashStore(paths, clock)).entryCount, 1);
});

test("add reports a committed result when directory sync fails after rename", async () => {
	const paths = resolveStashPaths("/committed-sync-failure", baseDir);
	const store = await loadStashStore(paths, clock, (filePath, file) =>
		writeStashFile(filePath, file, async () => {
			throw new Error("directory sync failed");
		}),
	);
	let resultId: string | undefined;

	await assert.rejects(
		() => store.add({ text: "durably uncertain" }),
		(error: unknown) => {
			if (!(error instanceof CommittedMutationError)) return false;
			resultId = (error.result as { id?: string }).id;
			return (
				typeof resultId === "string" &&
				error.failures.length === 1 &&
				error.failures[0]?.phase === "directory-sync"
			);
		},
	);

	assert.equal(store.entryCount, 1);
	const reopened = await loadStashStore(paths, clock);
	assert.equal(reopened.entryCount, 1);
	assert.equal(reopened.entries[0]?.id, resultId);
});

test("add keeps memory and disk unchanged when its write fails", async () => {
	const paths = resolveStashPaths("/failed-add", baseDir);
	const store = await loadStashStore(paths, clock, async () => {
		throw new Error("write failed");
	});

	await assert.rejects(() => store.add({ text: "not committed" }), /write failed/);

	assert.equal(store.entryCount, 0);
	assert.equal((await loadStashStore(paths, clock)).entryCount, 0);
});

test("add preserves mutation and unlock errors when both fail", async () => {
	const paths = resolveStashPaths("/double-failure", baseDir);
	const store = await loadStashStore(paths, clock, async () => {
		poisonLockOwner(paths);
		throw new Error("write failed");
	});

	await assert.rejects(
		() => store.add({ text: "not committed" }),
		(error: unknown) =>
			error instanceof AggregateError &&
			error.errors.some((nested) => String(nested).includes("write failed")) &&
			error.errors.some((nested) => String(nested).includes("symbolic link")),
	);
	removePoisonedLock(paths);
	assert.equal(existsSync(paths.stashFile), false);
});

test("pop durably leases restored image assets across restarts", async () => {
	const paths = resolveStashPaths("/restored-lease", baseDir);
	const store = await loadStashStore(paths, clock);
	const entry = await store.add({ text: "image", assetCount: 1 });

	await store.pop(entry.id);

	assert.deepEqual(store.restoredAssetLeaseIds, [entry.id]);
	assert.deepEqual((await loadStashStore(paths, clock)).restoredAssetLeaseIds, [entry.id]);
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

test("queueRestoredAssetCleanup retains active leases and queues abandoned leases", async () => {
	const store = await storeFor("/lease-cleanup");
	const retained = await store.add({ text: "retained", assetCount: 1 });
	const abandoned = await store.add({ text: "abandoned", assetCount: 1 });
	await store.pop(retained.id);
	await store.pop(abandoned.id);

	const result = await store.queueRestoredAssetCleanup([retained.id]);

	assert.deepEqual(result, { retained: [retained.id] });
	assert.deepEqual(store.restoredAssetLeaseIds, [retained.id]);
	assert.deepEqual(store.pendingAssetCleanupIds, [abandoned.id]);
});

test("concurrent restores preserve both asset leases", async () => {
	const paths = resolveStashPaths("/concurrent-restores", baseDir);
	const seed = await loadStashStore(paths, clock);
	const first = await seed.add({ text: "first", assetCount: 1 });
	const second = await seed.add({ text: "second", assetCount: 1 });
	const left = await loadStashStore(paths, clock);
	const right = await loadStashStore(paths, clock);

	await Promise.all([left.pop(first.id), right.pop(second.id)]);

	const reopened = await loadStashStore(paths, clock);
	assert.deepEqual(new Set(reopened.restoredAssetLeaseIds), new Set([first.id, second.id]));
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

test("clear keeps memory and disk unchanged when its write fails", async () => {
	const paths = resolveStashPaths("/failed-clear", baseDir);
	const seed = await loadStashStore(paths, clock);
	await seed.add({ text: "preserved" });
	const store = await loadStashStore(paths, clock, async () => {
		throw new Error("write failed");
	});

	await assert.rejects(() => store.clear(), /write failed/);

	assert.equal(store.entries[0]?.text, "preserved");
	assert.equal((await loadStashStore(paths, clock)).entries[0]?.text, "preserved");
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

	assert.equal(migrated.schemaVersion, STASH_SCHEMA_VERSION);
	assert.equal(store.entries[0]?.id, LEGACY_ENTRY_ID);
	assert.equal(store.entries[0]?.label, "legacy note");
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
	assert.equal(migrated.schemaVersion, STASH_SCHEMA_VERSION);
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
		STASH_SCHEMA_VERSION,
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

test("loads a committed schema v1 upgrade when the directory sync fails", async () => {
	const paths = resolveStashPaths("/legacy-sync-failure", baseDir);
	writeLegacyStash(paths, {
		entries: [{ id: LEGACY_ENTRY_ID, text: "preserved", createdAt: 1 }],
	});

	const loaded = await loadStashStore(paths, clock, async (filePath, file) => {
		await writeStashFile(filePath, file);
		return { committed: true, phase: "directory-sync", error: new Error("sync failed") };
	});

	assert.equal(loaded.entries[0]?.text, "preserved");
	assert.equal(
		JSON.parse(readFileSync(paths.stashFile, "utf8")).schemaVersion,
		STASH_SCHEMA_VERSION,
	);
	assert.match(loaded.takeDurabilityWarning() ?? "", /sync failed/u);
	assert.equal(loaded.takeDurabilityWarning(), undefined, "warning must be one-shot");
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

test("unsupported future schema remains untouched and reports recovery guidance", async () => {
	const paths = resolveStashPaths("/repo", baseDir);
	const original = JSON.stringify({
		schemaVersion: FUTURE_SCHEMA_VERSION,
		cwd: paths.sanitized,
		createdAt: 1,
		updatedAt: 1,
		entries: [],
	});
	writeFileSync(paths.stashFile, original);

	for (let attempt = 0; attempt < 2; attempt += 1) {
		await assert.rejects(
			() => loadStashStore(paths, clock),
			(error: unknown) =>
				error instanceof UnsupportedStashSchemaError &&
				error.detectedVersion === FUTURE_SCHEMA_VERSION &&
				error.supportedVersion === STASH_SCHEMA_VERSION &&
				error.message.toLowerCase().includes("upgrade") &&
				error.message.includes("export"),
		);
	}

	assert.equal(readFileSync(paths.stashFile, "utf8"), original);
	assert.equal(
		readdirSync(baseDir).some((name) => name.includes(".corrupt-")),
		false,
	);
});

test("missing and malformed schema metadata is quarantined as corrupt", async () => {
	for (const [cwd, raw] of [
		["/missing-version", { cwd: "--missing-version", entries: [] }],
		["/string-version", { schemaVersion: String(FUTURE_SCHEMA_VERSION), entries: [] }],
	] as const) {
		const paths = resolveStashPaths(cwd, baseDir);
		writeFileSync(paths.stashFile, JSON.stringify(raw));

		const store = await loadStashStore(paths, clock);

		assert.equal(store.entryCount, 0);
		assert.equal(existsSync(paths.stashFile), false);
	}
	assert.equal(readdirSync(baseDir).filter((name) => name.includes(".corrupt-")).length, 2);
});

test("a loaded store rejects a future schema introduced by another process", async () => {
	const paths = resolveStashPaths("/future-refresh", baseDir);
	const store = await loadStashStore(paths, clock);
	const original = JSON.stringify({
		schemaVersion: FUTURE_SCHEMA_VERSION,
		cwd: paths.sanitized,
		createdAt: 1,
		updatedAt: 1,
		entries: [],
	});
	writeFileSync(paths.stashFile, original);

	await assert.rejects(() => store.refresh(), UnsupportedStashSchemaError);
	await assert.rejects(() => store.add({ text: "blocked" }), UnsupportedStashSchemaError);
	assert.equal(readFileSync(paths.stashFile, "utf8"), original);
});

test("corrupt stash file is quarantined and treated as empty", async () => {
	const paths = resolveStashPaths("/repo", baseDir);
	writeFileSync(paths.stashFile, "{ not valid json ");
	const store = await loadStashStore(paths, clock);
	assert.equal(store.entryCount, 0);
	// The bad file was moved aside, not destroyed, and callers can surface it.
	const recoveryPath = store.takeCorruptRecoveryPath();
	assert.ok(recoveryPath);
	assert.ok(recoveryPath.includes(".corrupt-"));
	assert.equal(store.takeCorruptRecoveryPath(), undefined);
	assert.equal(readFileSync(recoveryPath, "utf8"), "{ not valid json ");
});

test("refresh reports concurrent corruption once and does not resurrect cached drafts", async () => {
	const paths = resolveStashPaths("/refresh-corruption", baseDir);
	const store = await loadStashStore(paths, clock);
	await store.add({ text: "must stay quarantined" });
	writeFileSync(paths.stashFile, "{ broken json");

	await store.refresh();
	const recoveryPath = store.takeCorruptRecoveryPath();

	assert.ok(recoveryPath);
	assert.ok(recoveryPath.includes(".corrupt-"));
	assert.equal(readFileSync(recoveryPath, "utf8"), "{ broken json");
	assert.equal(store.entryCount, 0);
	assert.equal(store.takeCorruptRecoveryPath(), undefined);
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

test("reclaims a fresh lock owned by a provably dead local process", async () => {
	const paths = resolveStashPaths("/fresh-dead-lock", baseDir);
	const store = await loadStashStore(paths, clock);
	const lockPath = `${paths.stashFile}.lock`;
	mkdirSync(lockPath);
	writeFileSync(
		path.join(lockPath, "owner.json"),
		JSON.stringify({
			pid: DEAD_PROCESS_ID,
			host: hostname(),
			token: TEST_LOCK_TOKEN,
			generation: "dead-generation",
			createdAt: new Date().toISOString(),
		}),
	);

	await store.add({ text: "recovered immediately" });

	assert.equal(store.entries[0]?.text, "recovered immediately");
});

test("reclaims a reused live pid whose process generation differs", async () => {
	const paths = resolveStashPaths("/reused-pid-lock", baseDir);
	const store = await loadStashStore(paths, clock);
	const lockPath = `${paths.stashFile}.lock`;
	mkdirSync(lockPath);
	writeFileSync(
		path.join(lockPath, "owner.json"),
		JSON.stringify({
			pid: process.pid,
			host: hostname(),
			token: TEST_LOCK_TOKEN,
			generation: `${await readProcessGeneration(process.pid)}-previous`,
			createdAt: new Date().toISOString(),
		}),
	);

	await store.add({ text: "pid safely reused" });

	assert.equal(store.entries[0]?.text, "pid safely reused");
});

test("diagnoses malformed fresh lock metadata without reclaiming it", async () => {
	const paths = resolveStashPaths("/malformed-lock", baseDir);
	const store = await loadStashStore(paths, clock);
	const lockPath = `${paths.stashFile}.lock`;
	mkdirSync(lockPath);
	writeFileSync(path.join(lockPath, "owner.json"), "not-json");

	await assert.rejects(() => store.add({ text: "blocked" }), /malformed lock owner metadata/);
	assert.equal(existsSync(lockPath), true);
});

test("does not reclaim a lock owned by a foreign host", async () => {
	const paths = resolveStashPaths("/foreign-host-lock", baseDir);
	const store = await loadStashStore(paths, clock);
	const lockPath = `${paths.stashFile}.lock`;
	mkdirSync(lockPath);
	writeFileSync(
		path.join(lockPath, "owner.json"),
		JSON.stringify({
			pid: DEAD_PROCESS_ID,
			host: "foreign-host",
			token: TEST_LOCK_TOKEN,
			generation: "foreign-generation",
			createdAt: new Date().toISOString(),
		}),
	);

	await assert.rejects(() => store.add({ text: "blocked" }), /uncertain lock owner/u);
	assert.equal(existsSync(lockPath), true);
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
			generation: await readProcessGeneration(process.pid),
			createdAt: new Date().toISOString(),
		}),
	);
	const staleTime = new Date(Date.now() - STALE_LOCK_AGE_MS);
	utimesSync(lockPath, staleTime, staleTime);

	await assert.rejects(() => store.add({ text: "blocked" }), /timed out waiting/);
});

test("a live cross-process owner blocks access and its crash is recovered immediately", async (t) => {
	const paths = resolveStashPaths("/cross-process-lock", baseDir);
	const store = await loadStashStore(paths, clock);
	const lockModule = pathToFileURL(path.resolve("src/lock.ts")).href;
	const child = spawn(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`import { withStashFileLock } from ${JSON.stringify(lockModule)};
await withStashFileLock(${JSON.stringify(paths.stashFile)}, async () => {
  process.stdout.write("locked\\n");
  await new Promise((resolve) => setTimeout(resolve, 10_000));
});`,
		],
		{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
	);
	t.after(() => child.kill("SIGKILL"));
	await new Promise<void>((resolve, reject) => {
		child.stdout?.once("data", () => resolve());
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`lock child exited early: ${code}`)));
	});

	await assert.rejects(() => store.add({ text: "blocked" }), /live lock owner/);
	child.kill("SIGKILL");
	await once(child, "exit");
	await store.add({ text: "recovered after crash" });

	assert.equal(store.entries[0]?.text, "recovered after crash");
});

test("reclaims stale malformed lock metadata after refusing it while fresh", async () => {
	const paths = resolveStashPaths("/stale-malformed-lock", baseDir);
	const store = await loadStashStore(paths, clock);
	const lockPath = `${paths.stashFile}.lock`;
	mkdirSync(lockPath);
	writeFileSync(path.join(lockPath, "owner.json"), "not-json");
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
				generation: "dead-generation",
				createdAt: new Date().toISOString(),
			}),
		);
		const staleTime = new Date(Date.now() - STALE_LOCK_AGE_MS);
		utimesSync(directory, staleTime, staleTime);
	}

	await store.add({ text: "recovered" });

	assert.equal(store.entries[0]?.text, "recovered");
});

test("reclaims a stale orphaned reclamation guard when the lock dir is gone", async () => {
	const paths = resolveStashPaths("/orphaned-reclaim", baseDir);
	const store = await loadStashStore(paths, clock);
	const reclaimPath = `${paths.stashFile}.lock.reclaim`;
	mkdirSync(reclaimPath);
	const staleTime = new Date(Date.now() - STALE_LOCK_AGE_MS);
	utimesSync(reclaimPath, staleTime, staleTime);

	await store.add({ text: "recovered" });

	assert.equal(store.entries[0]?.text, "recovered");
	assert.equal(existsSync(reclaimPath), false);
});

test("reclaims an orphaned reclamation guard whose dead owner left no lock", async () => {
	const paths = resolveStashPaths("/orphaned-reclaim-dead", baseDir);
	const store = await loadStashStore(paths, clock);
	const reclaimPath = `${paths.stashFile}.lock.reclaim`;
	mkdirSync(reclaimPath);
	writeFileSync(
		path.join(reclaimPath, "owner.json"),
		JSON.stringify({
			pid: DEAD_PROCESS_ID,
			host: hostname(),
			token: TEST_LOCK_TOKEN,
			generation: "dead-generation",
			createdAt: new Date().toISOString(),
		}),
	);

	await store.add({ text: "recovered" });

	assert.equal(store.entries[0]?.text, "recovered");
	assert.equal(existsSync(reclaimPath), false);
});

test("refuses a fresh malformed orphaned reclamation guard instead of hanging", async () => {
	const paths = resolveStashPaths("/orphaned-reclaim-fresh", baseDir);
	const store = await loadStashStore(paths, clock);
	mkdirSync(`${paths.stashFile}.lock.reclaim`);

	await assert.rejects(() => store.add({ text: "x" }), /timed out/u);
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
