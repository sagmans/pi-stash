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

import { migrateLegacyStash } from "../src/migrate.ts";
import { resolveStashPaths } from "../src/paths.ts";
import { loadStashStore, STASH_SCHEMA_VERSION } from "../src/store.ts";
import type { StashEntry, StashFile } from "../src/types.ts";

const CWD = "/worktrees/project";
const CREATED_AT = 1_700_000_000_000;
const ACTIVE_ID = "active-entry";
const PENDING_ID = "pending-entry";
const UNRELATED_ID = "unrelated-entry";
const ACTIVE_BYTES = Buffer.from("active image");
const PENDING_BYTES = Buffer.from("pending image");

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

function stashFile(entries: StashEntry[] = [], pendingAssetCleanup: string[] = []): StashFile {
	return {
		schemaVersion: STASH_SCHEMA_VERSION,
		cwd: resolveStashPaths(CWD, legacyBase).sanitized,
		createdAt: CREATED_AT,
		updatedAt: CREATED_AT,
		entries,
		restoredAssetLeases: [],
		pendingAssetCleanup,
	};
}

function writeLegacy(file: StashFile | string): ReturnType<typeof resolveStashPaths> {
	const paths = resolveStashPaths(CWD, legacyBase);
	mkdirSync(legacyBase, { recursive: true, mode: 0o700 });
	writeFileSync(paths.stashFile, typeof file === "string" ? file : JSON.stringify(file), {
		mode: 0o600,
	});
	return paths;
}

function writeAsset(paths: ReturnType<typeof resolveStashPaths>, id: string, bytes: Buffer): void {
	const directory = paths.assetDir(id);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	writeFileSync(path.join(directory, "00-image.png"), bytes, { mode: 0o600 });
}

test("migrateLegacyStash ignores an absent exact legacy scope", async () => {
	mkdirSync(path.join(legacyBase, "unrelated"), { recursive: true });

	const result = await migrateLegacyStash(CWD, destinationBase, legacyBase);

	assert.equal(result.kind, "not-needed");
	assert.equal(existsSync(resolveStashPaths(CWD, destinationBase).stashFile), false);
	assert.equal(existsSync(path.join(legacyBase, "unrelated")), true);
});

test("migrateLegacyStash moves an empty stash repeatably", async () => {
	const legacy = writeLegacy(stashFile());
	const destination = resolveStashPaths(CWD, destinationBase);

	assert.equal((await migrateLegacyStash(CWD, destinationBase, legacyBase)).kind, "migrated");
	assert.equal(existsSync(legacy.stashFile), false);
	assert.equal((await loadStashStore(destination)).entryCount, 0);
	assert.equal((await migrateLegacyStash(CWD, destinationBase, legacyBase)).kind, "not-needed");
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

	assert.equal((await migrateLegacyStash(CWD, destinationBase, legacyBase)).kind, "migrated");
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

	const result = await migrateLegacyStash(CWD, destinationBase, legacyBase);

	assert.equal(result.kind, "migrated");
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
		/destination.*legacy stash/i,
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

	assert.equal((await migrateLegacyStash(CWD, destinationBase, legacyBase)).kind, "resumed");
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
