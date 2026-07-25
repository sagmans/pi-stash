import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
	beginAddIntent,
	beginRestoreIntent,
	completeIntent,
	type MutationIntentOwner,
	reconcileMutationIntents,
} from "../src/intents.ts";
import { resolveStashPaths } from "../src/paths.ts";
import { loadStashStore } from "../src/store.ts";
import type { StashEntry } from "../src/types.ts";

const DEAD_PROCESS_ID = 2_147_483_647;
const ENTRY_ID = "intent-entry";
const CREATED_AT = 1_700_000_000_000;
const DEAD_OWNER: MutationIntentOwner = {
	pid: DEAD_PROCESS_ID,
	host: hostname(),
	startedAt: CREATED_AT,
	token: "dead-owner-token",
};

let baseDir: string;

beforeEach(() => {
	baseDir = mkdtempSync(path.join(tmpdir(), "pi-stash-intents-"));
});

afterEach(() => {
	rmSync(baseDir, { recursive: true, force: true });
});

function pathsFor(cwd: string) {
	return resolveStashPaths(cwd, baseDir);
}

function writeAsset(paths: ReturnType<typeof pathsFor>, id = ENTRY_ID): string {
	const directory = paths.assetDir(id);
	mkdirSync(directory, { recursive: true });
	writeFileSync(path.join(directory, "00-image.png"), "synthetic image");
	return directory;
}

function restoredEntry(): StashEntry {
	return {
		id: ENTRY_ID,
		text: "restore after crash",
		createdAt: CREATED_AT,
		message: "important",
		assetCount: 1,
	};
}

test("reconcileMutationIntents removes abandoned pre-commit add assets", async () => {
	const paths = pathsFor("/abandoned-add");
	const store = await loadStashStore(paths);
	const intent = await beginAddIntent(paths, ENTRY_ID, DEAD_OWNER);
	const assetDir = writeAsset(paths);

	const result = await reconcileMutationIntents(paths, store);

	assert.deepEqual(result, { removedStaging: 1, recoveredRestores: 0, skippedLive: 0 });
	assert.equal(existsSync(assetDir), false);
	assert.equal(existsSync(intent.filePath), false);
});

test("reconcileMutationIntents preserves assets after an add commit", async () => {
	const paths = pathsFor("/committed-add");
	const store = await loadStashStore(paths);
	const intent = await beginAddIntent(paths, ENTRY_ID, DEAD_OWNER);
	const assetDir = writeAsset(paths);
	await store.add({ id: ENTRY_ID, text: "committed", assetCount: 1 });

	const result = await reconcileMutationIntents(paths, store);

	assert.deepEqual(result, { removedStaging: 0, recoveredRestores: 0, skippedLive: 0 });
	assert.equal(existsSync(assetDir), true);
	assert.equal(existsSync(intent.filePath), false);
});

test("reconcileMutationIntents rolls back an interrupted restore", async () => {
	const paths = pathsFor("/interrupted-restore");
	const store = await loadStashStore(paths);
	const entry = restoredEntry();
	await store.add({ ...entry });
	const intent = await beginRestoreIntent(paths, entry, DEAD_OWNER);
	await store.pop(entry.id);

	const result = await reconcileMutationIntents(paths, store);

	assert.deepEqual(result, { removedStaging: 0, recoveredRestores: 1, skippedLive: 0 });
	assert.deepEqual(store.entries, [entry]);
	assert.equal(existsSync(intent.filePath), false);
});

test("reconcileMutationIntents clears a restore intent when the entry was not removed", async () => {
	const paths = pathsFor("/restore-before-commit");
	const store = await loadStashStore(paths);
	const entry = restoredEntry();
	await store.add({ ...entry });
	const intent = await beginRestoreIntent(paths, entry, DEAD_OWNER);

	const result = await reconcileMutationIntents(paths, store);

	assert.deepEqual(result, { removedStaging: 0, recoveredRestores: 0, skippedLive: 0 });
	assert.deepEqual(store.entries, [entry]);
	assert.equal(existsSync(intent.filePath), false);
});

test("reconcileMutationIntents does not touch a live operation", async () => {
	const paths = pathsFor("/live-intent");
	const store = await loadStashStore(paths);
	const intent = await beginAddIntent(paths, ENTRY_ID);
	const assetDir = writeAsset(paths);

	const result = await reconcileMutationIntents(paths, store);

	assert.deepEqual(result, { removedStaging: 0, recoveredRestores: 0, skippedLive: 1 });
	assert.equal(existsSync(assetDir), true);
	assert.equal(existsSync(intent.filePath), true);
	await completeIntent(intent);
});

test("completeIntent is idempotent and removes an empty intent directory", async () => {
	const paths = pathsFor("/complete-intent");
	const intent = await beginAddIntent(paths, ENTRY_ID, DEAD_OWNER);
	const intentRoot = path.dirname(intent.filePath);

	await completeIntent(intent);
	await completeIntent(intent);

	assert.equal(existsSync(intent.filePath), false);
	assert.equal(existsSync(intentRoot), false);
	assert.deepEqual(
		existsSync(baseDir) ? readdirSync(baseDir).filter((name) => name.includes("intent")) : [],
		[],
	);
});
