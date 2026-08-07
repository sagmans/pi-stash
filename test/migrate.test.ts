import { strict as assert } from "node:assert";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
	findLegacyMigrationConflicts,
	MigrationConflictError,
	migrateAllLegacyStashes,
	migrateLegacyStash,
} from "../src/migrate.ts";
import { resolveLegacyStashPaths, resolveStashPaths } from "../src/paths.ts";
import { loadStashStore, STASH_SCHEMA_VERSION } from "../src/store.ts";
import type { StashEntry, StashFile } from "../src/types.ts";

const CWD = "/worktrees/project";
const CREATED_AT = 1_700_000_000_000;
const ACTIVE_ID = "active-entry";
const PENDING_ID = "pending-entry";
const UNRELATED_ID = "unrelated-entry";
const ACTIVE_BYTES = Buffer.from("active image");
const PENDING_BYTES = Buffer.from("pending image");
const ROOT_CWD = "/";
const COLLIDING_SEGMENT_CWD = "/a--b";
const COLLIDING_PATH_CWD = "/a/b";
const FIRST_SWEEP_CWD = "/a/scope";
const SECOND_SWEEP_CWD = "/z/scope";
const LONG_CWD = `/${"segment-".repeat(40)}`;

let scratch: string;
let legacyBase: string;
let destinationBase: string;

beforeEach(() => {
	scratch = mkdtempSync(path.join(tmpdir(), "pi-stash-migrate-"));
	legacyBase = path.join(scratch, "legacy", "pi-stash");
	destinationBase = path.join(scratch, "configured", "pi-stash");
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function stashFile(
	entries: StashEntry[] = [],
	pendingAssetCleanup: string[] = [],
	cwd = CWD,
): StashFile {
	return {
		schemaVersion: STASH_SCHEMA_VERSION,
		cwd: resolveStashPaths(cwd, legacyBase).sanitized,
		createdAt: CREATED_AT,
		updatedAt: CREATED_AT,
		entries,
		restoredAssetLeases: [],
		pendingAssetCleanup,
	};
}

function writeLegacyFor(
	cwd: string,
	file: StashFile | string,
): ReturnType<typeof resolveStashPaths> {
	const paths = resolveStashPaths(cwd, legacyBase);
	mkdirSync(legacyBase, { recursive: true, mode: 0o700 });
	writeFileSync(paths.stashFile, typeof file === "string" ? file : JSON.stringify(file), {
		mode: 0o600,
	});
	return paths;
}

function writeLegacy(file: StashFile | string): ReturnType<typeof resolveStashPaths> {
	return writeLegacyFor(CWD, file);
}

function writeAsset(paths: ReturnType<typeof resolveStashPaths>, id: string, bytes: Buffer): void {
	const directory = paths.assetDir(id);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	writeFileSync(path.join(directory, "00-image.png"), bytes, { mode: 0o600 });
}

test("migrateLegacyStash ignores an absent exact legacy scope", async () => {
	mkdirSync(path.join(legacyBase, "unrelated"), { recursive: true });

	const didMigrate = await migrateLegacyStash(CWD, destinationBase, legacyBase);

	assert.equal(didMigrate, false);
	assert.equal(existsSync(resolveStashPaths(CWD, destinationBase).stashFile), false);
	assert.equal(existsSync(path.join(legacyBase, "unrelated")), true);
});

test("migrateLegacyStash moves an empty stash repeatably", async () => {
	const legacy = writeLegacy(stashFile());
	const destination = resolveStashPaths(CWD, destinationBase);

	assert.equal(await migrateLegacyStash(CWD, destinationBase, legacyBase), true);
	assert.equal(existsSync(legacy.stashFile), false);
	assert.equal((await loadStashStore(destination)).entryCount, 0);
	assert.equal(await migrateLegacyStash(CWD, destinationBase, legacyBase), false);
});

test("migrateLegacyStash upgrades historical schema v1 state", async () => {
	const entry: StashEntry = {
		id: ACTIVE_ID,
		text: "schema one",
		createdAt: CREATED_AT,
	};
	const legacyFile = stashFile([entry]);
	writeLegacy(JSON.stringify({ ...legacyFile, schemaVersion: 1, pendingAssetCleanup: undefined }));
	const destination = resolveStashPaths(CWD, destinationBase);

	assert.equal(await migrateLegacyStash(CWD, destinationBase, legacyBase), true);
	assert.equal((await loadStashStore(destination)).entries[0]?.text, "schema one");
	assert.equal(
		JSON.parse(readFileSync(destination.stashFile, "utf8")).schemaVersion,
		STASH_SCHEMA_VERSION,
	);
});

test("migrateLegacyStash commits populated state and only its owned assets", async () => {
	const entry: StashEntry = {
		id: ACTIVE_ID,
		text: "draft",
		createdAt: CREATED_AT,
		assetCount: 1,
	};
	const legacy = writeLegacy(stashFile([entry], [PENDING_ID]));
	writeAsset(legacy, ACTIVE_ID, ACTIVE_BYTES);
	writeAsset(legacy, PENDING_ID, PENDING_BYTES);
	writeAsset(legacy, UNRELATED_ID, Buffer.from("unrelated"));
	writeFileSync(path.join(legacyBase, "other-scope.json"), "unrelated");
	const destination = resolveStashPaths(CWD, destinationBase);

	const didMigrate = await migrateLegacyStash(CWD, destinationBase, legacyBase);

	assert.equal(didMigrate, true);
	const migrated = await loadStashStore(destination);
	assert.deepEqual(migrated.entries, [entry]);
	assert.deepEqual(migrated.pendingAssetCleanupIds, [PENDING_ID]);
	assert.deepEqual(
		readFileSync(path.join(destination.assetDir(ACTIVE_ID), "00-image.png")),
		ACTIVE_BYTES,
	);
	assert.deepEqual(
		readFileSync(path.join(destination.assetDir(PENDING_ID), "00-image.png")),
		PENDING_BYTES,
	);
	assert.equal(existsSync(legacy.assetDir(ACTIVE_ID)), false);
	assert.equal(existsSync(legacy.assetDir(PENDING_ID)), false);
	assert.equal(existsSync(legacy.assetDir(UNRELATED_ID)), true);
	assert.equal(existsSync(path.join(legacyBase, "other-scope.json")), true);
});

test("migrateLegacyStash rejects a destination conflict without overwriting either side", async () => {
	const legacy = writeLegacy(stashFile());
	const destination = resolveStashPaths(CWD, destinationBase);
	mkdirSync(destinationBase, { recursive: true });
	writeFileSync(destination.stashFile, "destination");

	await assert.rejects(
		() => migrateLegacyStash(CWD, destinationBase, legacyBase),
		(error) => {
			assert.ok(error instanceof MigrationConflictError);
			assert.equal(error.phase, "preflight");
			assert.equal(error.sourceStashFile, legacy.stashFile);
			assert.equal(error.destinationStashFile, destination.stashFile);
			assert.match(error.message, /remove/iu);
			assert.match(error.message, /reload/iu);
			return true;
		},
	);
	assert.equal(readFileSync(destination.stashFile, "utf8"), "destination");
	assert.equal(existsSync(legacy.stashFile), true);
});

test("migrateLegacyStash rejects malformed legacy state non-destructively", async () => {
	const legacy = writeLegacy("{ malformed");
	const destination = resolveStashPaths(CWD, destinationBase);

	await assert.rejects(
		() => migrateLegacyStash(CWD, destinationBase, legacyBase),
		/malformed legacy stash/i,
	);
	assert.equal(readFileSync(legacy.stashFile, "utf8"), "{ malformed");
	assert.equal(existsSync(destination.stashFile), false);
});

test("migrateLegacyStash resumes after assets copy but before state commit", async () => {
	const entry: StashEntry = {
		id: ACTIVE_ID,
		text: "interrupted",
		createdAt: CREATED_AT,
		assetCount: 1,
	};
	const legacy = writeLegacy(stashFile([entry]));
	writeAsset(legacy, ACTIVE_ID, ACTIVE_BYTES);
	const destination = resolveStashPaths(CWD, destinationBase);

	await assert.rejects(
		() => migrateLegacyStash(CWD, destinationBase, legacyBase, { failAfter: "assets" }),
		/simulated migration interruption/,
	);
	assert.equal(existsSync(destination.stashFile), false);
	assert.deepEqual(readdirSync(destination.assetDir(ACTIVE_ID)), ["00-image.png"]);
	assert.equal(existsSync(legacy.stashFile), true);

	assert.equal(await migrateLegacyStash(CWD, destinationBase, legacyBase), true);
	assert.equal((await loadStashStore(destination)).entries[0]?.text, "interrupted");
	assert.equal(existsSync(legacy.stashFile), false);
	assert.equal(
		readdirSync(destinationBase).some((name) => name.endsWith(".migration.json")),
		false,
	);
});

test("migrateLegacyStash requires active persisted image ownership to be complete", async () => {
	const entry: StashEntry = {
		id: ACTIVE_ID,
		text: "missing image",
		createdAt: CREATED_AT,
		assetCount: 1,
	};
	const legacy = writeLegacy(stashFile([entry]));

	await assert.rejects(
		() => migrateLegacyStash(CWD, destinationBase, legacyBase),
		/missing owned assets.*active-entry/i,
	);
	assert.equal(existsSync(legacy.stashFile), true);
});

test("migrateLegacyStash migrates an asset held only by a restored lease", async () => {
	const leaseId = "leased-entry";
	const leaseBytes = Buffer.from("leased image");
	const file = stashFile();
	file.restoredAssetLeases = [leaseId];
	const legacy = writeLegacy(file);
	writeAsset(legacy, leaseId, leaseBytes);
	const destination = resolveStashPaths(CWD, destinationBase);

	const didMigrate = await migrateLegacyStash(CWD, destinationBase, legacyBase);

	assert.equal(didMigrate, true);
	assert.deepEqual(
		readFileSync(path.join(destination.assetDir(leaseId), "00-image.png")),
		leaseBytes,
	);
	assert.equal(existsSync(legacy.assetDir(leaseId)), false);
	assert.deepEqual((await loadStashStore(destination)).restoredAssetLeaseIds, [leaseId]);
});

test("migrateLegacyStash invokes syncSourceParent after source removal and resumes on retry", async () => {
	const entry: StashEntry = {
		id: ACTIVE_ID,
		text: "synced source parent",
		createdAt: CREATED_AT,
		assetCount: 1,
	};
	const legacy = writeLegacy(stashFile([entry]));
	writeAsset(legacy, ACTIVE_ID, ACTIVE_BYTES);
	const destination = resolveStashPaths(CWD, destinationBase);
	const markerPath = `${destination.stashFile}.migration.json`;
	const recorded: string[] = [];
	const sentinel = new Error("sync source parent failed");

	await assert.rejects(
		() =>
			migrateLegacyStash(CWD, destinationBase, legacyBase, {
				syncSourceParent: async (directory: string) => {
					recorded.push(directory);
					throw sentinel;
				},
			}),
		/sync source parent failed/,
	);

	assert.deepEqual(recorded, [path.dirname(legacy.stashFile)]);
	assert.equal(existsSync(legacy.stashFile), false);
	assert.equal(existsSync(legacy.assetDir(ACTIVE_ID)), false);
	assert.equal(existsSync(markerPath), true);

	assert.equal(await migrateLegacyStash(CWD, destinationBase, legacyBase), true);
	assert.equal((await loadStashStore(destination)).entries[0]?.text, "synced source parent");
	assert.equal(existsSync(legacy.stashFile), false);
	assert.equal(existsSync(markerPath), false);
});

type LegacyV1Entry = {
	id: string;
	text: string;
	createdAt: number;
	message?: string;
	assetCount?: number;
};

function writeLegacyV1(
	entries: LegacyV1Entry[] = [],
	cwdKey?: string,
): ReturnType<typeof resolveLegacyStashPaths> {
	const paths = resolveLegacyStashPaths(CWD, legacyBase);
	mkdirSync(legacyBase, { recursive: true, mode: 0o700 });
	const file = {
		schemaVersion: 1,
		cwd: cwdKey ?? paths.sanitized,
		createdAt: CREATED_AT,
		updatedAt: CREATED_AT,
		entries,
	};
	writeFileSync(paths.stashFile, JSON.stringify(file), { mode: 0o600 });
	return paths;
}

test("migrateLegacyStash migrates an unprefixed v1-key stash across roots", async () => {
	const entry: LegacyV1Entry = {
		id: ACTIVE_ID,
		text: "vendored draft",
		createdAt: CREATED_AT,
		message: "vendored label",
		assetCount: 1,
	};
	const legacy = writeLegacyV1([entry]);
	writeAsset(legacy, ACTIVE_ID, ACTIVE_BYTES);
	const destination = resolveStashPaths(CWD, destinationBase);

	const didMigrate = await migrateLegacyStash(CWD, destinationBase, legacyBase);

	assert.equal(didMigrate, true);
	const migrated = await loadStashStore(destination);
	assert.equal(migrated.entries[0]?.text, "vendored draft");
	assert.equal(migrated.entries[0]?.label, "vendored label");
	assert.deepEqual(
		readFileSync(path.join(destination.assetDir(ACTIVE_ID), "00-image.png")),
		ACTIVE_BYTES,
	);
	assert.equal(
		JSON.parse(readFileSync(destination.stashFile, "utf8")).schemaVersion,
		STASH_SCHEMA_VERSION,
	);
	assert.equal(JSON.parse(readFileSync(destination.stashFile, "utf8")).cwd, destination.sanitized);
	assert.equal(existsSync(legacy.stashFile), false);
	assert.equal(existsSync(legacy.assetDir(ACTIVE_ID)), false);
});

test("migrateLegacyStash upgrades a v1-key stash in place under the same root", async () => {
	const entry: LegacyV1Entry = {
		id: ACTIVE_ID,
		text: "same root draft",
		createdAt: CREATED_AT,
	};
	const legacy = writeLegacyV1([entry]);
	writeAsset(legacy, ACTIVE_ID, ACTIVE_BYTES);
	const destination = resolveStashPaths(CWD, legacyBase);

	assert.equal(await migrateLegacyStash(CWD, legacyBase, legacyBase), true);
	assert.equal(existsSync(legacy.stashFile), false);
	assert.equal(existsSync(legacy.assetDir(ACTIVE_ID)), false);
	assert.equal((await loadStashStore(destination)).entries[0]?.text, "same root draft");
	assert.equal(await migrateLegacyStash(CWD, legacyBase, legacyBase), false);
});

test("migrateLegacyStash resumes a same-root v1-key migration after asset copy", async () => {
	const entry: LegacyV1Entry = {
		id: ACTIVE_ID,
		text: "interrupted same root",
		createdAt: CREATED_AT,
		assetCount: 1,
	};
	const legacy = writeLegacyV1([entry]);
	writeAsset(legacy, ACTIVE_ID, ACTIVE_BYTES);
	const destination = resolveStashPaths(CWD, legacyBase);

	await assert.rejects(
		() => migrateLegacyStash(CWD, legacyBase, legacyBase, { failAfter: "assets" }),
		/simulated migration interruption/,
	);
	assert.equal(existsSync(destination.stashFile), false);
	assert.equal(existsSync(legacy.stashFile), true);

	assert.equal(await migrateLegacyStash(CWD, legacyBase, legacyBase), true);
	assert.equal((await loadStashStore(destination)).entries[0]?.text, "interrupted same root");
	assert.equal(existsSync(legacy.stashFile), false);
	assert.equal(
		readdirSync(legacyBase).some((name) => name.endsWith(".migration.json")),
		false,
	);
});

test("migrateLegacyStash refuses a same-root v1-key stash beside live v2 state", async () => {
	writeLegacyV1();
	const destination = resolveStashPaths(CWD, legacyBase);
	mkdirSync(legacyBase, { recursive: true });
	writeFileSync(destination.stashFile, "live state", { mode: 0o600 });

	await assert.rejects(
		() => migrateLegacyStash(CWD, legacyBase, legacyBase),
		/destination.*legacy stash/i,
	);
	assert.equal(readFileSync(destination.stashFile, "utf8"), "live state");
	assert.equal(existsSync(resolveLegacyStashPaths(CWD, legacyBase).stashFile), true);
});

test("migrateLegacyStash rejects a v1-key file whose recorded cwd disagrees", async () => {
	const legacy = writeLegacyV1([], "--elsewhere");

	await assert.rejects(
		() => migrateLegacyStash(CWD, destinationBase, legacyBase),
		/malformed legacy stash/i,
	);
	assert.equal(existsSync(legacy.stashFile), true);
	assert.equal(existsSync(resolveStashPaths(CWD, destinationBase).stashFile), false);
});

test("migrateAllLegacyStashes sweeps v1-key and legacy-root v2-key scopes", async () => {
	const v1Entry: LegacyV1Entry = { id: ACTIVE_ID, text: "v1 sweep", createdAt: CREATED_AT };
	const v1 = writeLegacyV1([v1Entry]);
	const otherCwd = "/other/scope";
	const v2Legacy = resolveStashPaths(otherCwd, legacyBase);
	mkdirSync(legacyBase, { recursive: true, mode: 0o700 });
	writeFileSync(
		v2Legacy.stashFile,
		JSON.stringify({
			schemaVersion: STASH_SCHEMA_VERSION,
			cwd: v2Legacy.sanitized,
			createdAt: CREATED_AT,
			updatedAt: CREATED_AT,
			entries: [{ id: PENDING_ID, text: "v2 sweep", createdAt: CREATED_AT }],
			restoredAssetLeases: [],
			pendingAssetCleanup: [],
		}),
		{ mode: 0o600 },
	);

	const summary = await migrateAllLegacyStashes(destinationBase, legacyBase, {
		authoritativeCwd: CWD,
	});

	assert.deepEqual(summary, { migrated: 2, skipped: [] });
	assert.equal(existsSync(v1.stashFile), false);
	assert.equal(existsSync(v2Legacy.stashFile), false);
	assert.equal((await loadStashStore(resolveStashPaths(CWD, destinationBase))).entryCount, 1);
	assert.equal((await loadStashStore(resolveStashPaths(otherCwd, destinationBase))).entryCount, 1);
});

test("migrateAllLegacyStashes reports conflicts without moving either source", async () => {
	const v1 = writeLegacyV1([{ id: ACTIVE_ID, text: "superseded", createdAt: CREATED_AT }]);
	writeAsset(v1, ACTIVE_ID, ACTIVE_BYTES);
	const destination = resolveStashPaths(CWD, legacyBase);
	await (await loadStashStore(destination)).add({ text: "authoritative" });

	const summary = await migrateAllLegacyStashes(legacyBase, legacyBase, {
		authoritativeCwd: CWD,
	});

	assert.equal(summary.migrated, 0);
	assert.equal(summary.skipped.length, 1);
	assert.match(summary.skipped[0]?.reason ?? "", /destination conflicts/iu);
	assert.equal(existsSync(v1.stashFile), true);
	assert.equal(existsSync(v1.assetsRoot), true);
	assert.equal(existsSync(destination.stashFile), true);
	assert.equal((await loadStashStore(destination)).entries[0]?.text, "authoritative");
});

test("migrateAllLegacyStashes leaves non-injective v1 keys for an authoritative cwd", async () => {
	const colliding = resolveLegacyStashPaths(COLLIDING_SEGMENT_CWD, legacyBase);
	assert.equal(
		colliding.stashFile,
		resolveLegacyStashPaths(COLLIDING_PATH_CWD, legacyBase).stashFile,
	);
	mkdirSync(legacyBase, { recursive: true, mode: 0o700 });
	writeFileSync(
		colliding.stashFile,
		JSON.stringify({
			schemaVersion: 1,
			cwd: colliding.sanitized,
			createdAt: CREATED_AT,
			updatedAt: CREATED_AT,
			entries: [],
		}),
		{ mode: 0o600 },
	);

	const summary = await migrateAllLegacyStashes(destinationBase, legacyBase);

	assert.equal(summary.migrated, 0);
	assert.equal(summary.skipped.length, 1);
	assert.match(summary.skipped[0]?.reason ?? "", /authoritative current working directory/iu);
	assert.equal(existsSync(colliding.stashFile), true);
	assert.equal(
		existsSync(resolveStashPaths(COLLIDING_SEGMENT_CWD, destinationBase).stashFile),
		false,
	);
	assert.equal(existsSync(resolveStashPaths(COLLIDING_PATH_CWD, destinationBase).stashFile), false);
});

test("migrateAllLegacyStashes migrates root but rejects truncated v2 scope keys", async () => {
	const root = writeLegacyFor(ROOT_CWD, stashFile([], [], ROOT_CWD));
	const truncated = writeLegacyFor(LONG_CWD, stashFile([], [], LONG_CWD));

	const summary = await migrateAllLegacyStashes(destinationBase, legacyBase);

	assert.equal(summary.migrated, 1);
	assert.equal(summary.skipped.length, 1);
	assert.equal(summary.skipped[0]?.file, truncated.stashFile);
	assert.match(summary.skipped[0]?.reason ?? "", /not reversibly decodable/iu);
	assert.equal(existsSync(root.stashFile), false);
	assert.equal(existsSync(truncated.stashFile), true);
	assert.equal(existsSync(resolveStashPaths(ROOT_CWD, destinationBase).stashFile), true);
});

test("authoritative cwd resumes a marker whose v2 key was truncated", async () => {
	const legacy = writeLegacyFor(LONG_CWD, stashFile([], [], LONG_CWD));
	await assert.rejects(
		() => migrateLegacyStash(LONG_CWD, destinationBase, legacyBase, { failAfter: "marker" }),
		/simulated migration interruption/iu,
	);

	const summary = await migrateAllLegacyStashes(destinationBase, legacyBase, {
		authoritativeCwd: LONG_CWD,
	});

	assert.deepEqual(summary, { migrated: 1, skipped: [] });
	assert.equal(existsSync(legacy.stashFile), false);
	assert.equal(existsSync(resolveStashPaths(LONG_CWD, destinationBase).stashFile), true);
});

test("migration planning refuses competing v1 and v2 sources without a marker", async () => {
	const v2 = writeLegacy(stashFile());
	const v1 = writeLegacyV1();

	await assert.rejects(
		() => migrateLegacyStash(CWD, destinationBase, legacyBase),
		/multiple legacy sources/iu,
	);
	const summary = await migrateAllLegacyStashes(destinationBase, legacyBase, {
		authoritativeCwd: CWD,
	});

	assert.equal(summary.migrated, 0);
	assert.equal(summary.skipped.length, 2);
	assert.ok(summary.skipped.every(({ reason }) => /multiple legacy sources/iu.test(reason)));
	assert.equal(existsSync(v1.stashFile), true);
	assert.equal(existsSync(v2.stashFile), true);
});

test("migration markers cannot redirect source access outside the configured legacy root", async () => {
	const legacy = writeLegacy(stashFile());
	const destination = resolveStashPaths(CWD, destinationBase);
	await assert.rejects(
		() => migrateLegacyStash(CWD, destinationBase, legacyBase, { failAfter: "marker" }),
		/simulated migration interruption/iu,
	);
	const markerPath = `${destination.stashFile}.migration.json`;
	const marker = JSON.parse(readFileSync(markerPath, "utf8"));
	const outside = resolveStashPaths(CWD, path.join(scratch, "outside"));
	mkdirSync(path.dirname(outside.stashFile), { recursive: true, mode: 0o700 });
	writeFileSync(outside.stashFile, JSON.stringify(stashFile()), { mode: 0o600 });
	writeFileSync(markerPath, JSON.stringify({ ...marker, sourceStashFile: outside.stashFile }), {
		mode: 0o600,
	});

	await assert.rejects(
		() => migrateLegacyStash(CWD, destinationBase, legacyBase),
		/source scope mismatch/iu,
	);
	assert.equal(existsSync(legacy.stashFile), true);
	assert.equal(existsSync(outside.stashFile), true);
});

test("post-marker conflicts remain typed and never trigger source quarantine", async () => {
	const entry: StashEntry = {
		id: ACTIVE_ID,
		text: "conflicting asset",
		createdAt: CREATED_AT,
		assetCount: 1,
	};
	const legacy = writeLegacy(stashFile([entry]));
	writeAsset(legacy, ACTIVE_ID, ACTIVE_BYTES);
	const destination = resolveStashPaths(CWD, destinationBase);
	await assert.rejects(
		() => migrateLegacyStash(CWD, destinationBase, legacyBase, { failAfter: "assets" }),
		/simulated migration interruption/iu,
	);
	writeFileSync(path.join(destination.assetDir(ACTIVE_ID), "00-image.png"), PENDING_BYTES);

	await assert.rejects(
		() => migrateLegacyStash(CWD, destinationBase, legacyBase),
		(error) => {
			assert.ok(error instanceof MigrationConflictError);
			assert.equal(error.phase, "assets");
			return true;
		},
	);
	const summary = await migrateAllLegacyStashes(destinationBase, legacyBase, {
		authoritativeCwd: CWD,
	});

	assert.equal(summary.migrated, 0);
	assert.equal(summary.skipped.length, 1);
	assert.equal(existsSync(legacy.stashFile), true);
	assert.equal(
		readdirSync(legacyBase).some((name) => name.includes("migrate-conflict")),
		false,
	);
});

test("migrateAllLegacyStashes stops between scopes when aborted", async () => {
	const first = writeLegacyFor(
		FIRST_SWEEP_CWD,
		stashFile([{ id: ACTIVE_ID, text: "first", createdAt: CREATED_AT }], [], FIRST_SWEEP_CWD),
	);
	const second = writeLegacyFor(
		SECOND_SWEEP_CWD,
		stashFile([{ id: PENDING_ID, text: "second", createdAt: CREATED_AT }], [], SECOND_SWEEP_CWD),
	);
	const abort = new AbortController();

	const summary = await migrateAllLegacyStashes(destinationBase, legacyBase, {
		signal: abort.signal,
		syncSourceParent: async () => abort.abort(),
	});

	assert.equal(summary.migrated, 1);
	assert.equal(existsSync(first.stashFile), false);
	assert.equal(existsSync(second.stashFile), true);
});

test("migrateAllLegacyStashes skips malformed, unrelated, and marker files", async () => {
	mkdirSync(legacyBase, { recursive: true, mode: 0o700 });
	const malformed = path.join(legacyBase, "--malformed--scope.json");
	writeFileSync(malformed, "{ not json", { mode: 0o600 });
	const marker = path.join(legacyBase, "v2--marker--scope.json.migration.json");
	writeFileSync(marker, "{}", { mode: 0o600 });
	const unrelated = path.join(legacyBase, "notes.txt");
	writeFileSync(unrelated, "ignored", { mode: 0o600 });

	const summary = await migrateAllLegacyStashes(destinationBase, legacyBase);

	assert.deepEqual(summary.skipped, [
		{ file: malformed, reason: "malformed legacy stash cannot be migrated" },
	]);
	assert.equal(summary.migrated, 0);
	assert.equal(existsSync(malformed), true);
	assert.equal(existsSync(marker), true);
	assert.equal(existsSync(unrelated), true);
});

test("migrateAllLegacyStashes tolerates an absent legacy root", async () => {
	const summary = await migrateAllLegacyStashes(destinationBase, path.join(scratch, "missing"));
	assert.deepEqual(summary, { migrated: 0, skipped: [] });
});

test("findLegacyMigrationConflicts reports only scopes with existing destinations", async () => {
	const conflicting = writeLegacyV1([{ id: ACTIVE_ID, text: "old", createdAt: CREATED_AT }]);
	const destination = resolveStashPaths(CWD, legacyBase);
	await (await loadStashStore(destination)).add({ text: "current" });
	const cleanScope = resolveLegacyStashPaths("/clean/scope", legacyBase);
	mkdirSync(legacyBase, { recursive: true, mode: 0o700 });
	writeFileSync(
		cleanScope.stashFile,
		JSON.stringify({
			schemaVersion: STASH_SCHEMA_VERSION,
			cwd: cleanScope.sanitized,
			createdAt: CREATED_AT,
			updatedAt: CREATED_AT,
			entries: [],
		}),
		{ mode: 0o600 },
	);

	const conflicts = await findLegacyMigrationConflicts(legacyBase, legacyBase, CWD);

	assert.deepEqual(conflicts, [conflicting.stashFile]);
});
