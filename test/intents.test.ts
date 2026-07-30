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
	generation: "dead-generation",
};
const STALE_GENERATION_STARTED_AT = 1_000_000_000_000;
const STALE_GENERATION_OWNER: MutationIntentOwner = {
	pid: process.pid,
	host: hostname(),
	startedAt: STALE_GENERATION_STARTED_AT,
	token: "stale-generation-token",
	generation: "stale-generation",
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

	const didRecoverRestore = await reconcileMutationIntents(paths, store);

	assert.equal(didRecoverRestore, false);
	assert.equal(existsSync(assetDir), false);
	assert.equal(existsSync(intent.filePath), false);
});

test("reconcileMutationIntents preserves assets after an add commit", async () => {
	const paths = pathsFor("/committed-add");
	const store = await loadStashStore(paths);
	const intent = await beginAddIntent(paths, ENTRY_ID, DEAD_OWNER);
	const assetDir = writeAsset(paths);
	await store.add({ id: ENTRY_ID, text: "committed", assetCount: 1 });

	const didRecoverRestore = await reconcileMutationIntents(paths, store);

	assert.equal(didRecoverRestore, false);
	assert.equal(existsSync(assetDir), true);
	assert.equal(existsSync(intent.filePath), false);
});

test("reconcileMutationIntents preserves leased assets after a committed add was restored", async () => {
	const paths = pathsFor("/leased-add");
	const store = await loadStashStore(paths);
	const intent = await beginAddIntent(paths, ENTRY_ID, DEAD_OWNER);
	const assetDir = writeAsset(paths);
	await store.add({ id: ENTRY_ID, text: "committed", assetCount: 1 });
	await store.pop(ENTRY_ID);
	assert.deepEqual(store.restoredAssetLeaseIds, [ENTRY_ID]);

	const didRecoverRestore = await reconcileMutationIntents(paths, store);

	assert.equal(didRecoverRestore, false);
	assert.equal(existsSync(assetDir), true, "leased assets must survive add-intent recovery");
	assert.equal(existsSync(intent.filePath), false);
	assert.deepEqual(store.restoredAssetLeaseIds, [ENTRY_ID]);
});

test("reconcileMutationIntents still clears dropped-entry assets queued for cleanup", async () => {
	const paths = pathsFor("/dropped-add");
	const store = await loadStashStore(paths);
	const intent = await beginAddIntent(paths, ENTRY_ID, DEAD_OWNER);
	const assetDir = writeAsset(paths);
	await store.add({ id: ENTRY_ID, text: "committed", assetCount: 1 });
	await store.drop(ENTRY_ID);

	const didRecoverRestore = await reconcileMutationIntents(paths, store);

	assert.equal(didRecoverRestore, false);
	assert.equal(existsSync(assetDir), false);
	assert.deepEqual(store.pendingAssetCleanupIds, [ENTRY_ID]);
	assert.equal(existsSync(intent.filePath), false);
});

test("reconcileMutationIntents tolerates a concurrent reconciler winning the restore", async () => {
	const paths = pathsFor("/concurrent-restore");
	const seed = await loadStashStore(paths);
	const entry = restoredEntry();
	await seed.add({ ...entry });
	const intent = await beginRestoreIntent(paths, entry, DEAD_OWNER);
	await seed.pop(entry.id);

	const store = await loadStashStore(paths);
	const rival = await loadStashStore(paths);
	const originalAdd = store.add.bind(store);
	let interleaved = false;
	store.add = async (input) => {
		if (!interleaved && input.id === entry.id) {
			interleaved = true;
			await rival.add(input);
		}
		return originalAdd(input);
	};

	const didRecoverRestore = await reconcileMutationIntents(paths, store);

	assert.equal(interleaved, true, "test must interleave the rival commit");
	assert.equal(didRecoverRestore, false);
	assert.deepEqual(
		store.entries.map(({ id }) => id),
		[entry.id],
	);
	assert.equal(existsSync(intent.filePath), false);
});

test("reconcileMutationIntents rolls back an interrupted restore", async () => {
	const paths = pathsFor("/interrupted-restore");
	const store = await loadStashStore(paths);
	const entry = restoredEntry();
	await store.add({ ...entry });
	const intent = await beginRestoreIntent(paths, entry, DEAD_OWNER);
	await store.pop(entry.id);

	const didRecoverRestore = await reconcileMutationIntents(paths, store);

	assert.equal(didRecoverRestore, true);
	assert.deepEqual(store.entries, [entry]);
	assert.equal(existsSync(intent.filePath), false);
});

test("reconcileMutationIntents clears a restore intent when the entry was not removed", async () => {
	const paths = pathsFor("/restore-before-commit");
	const store = await loadStashStore(paths);
	const entry = restoredEntry();
	await store.add({ ...entry });
	const intent = await beginRestoreIntent(paths, entry, DEAD_OWNER);

	const didRecoverRestore = await reconcileMutationIntents(paths, store);

	assert.equal(didRecoverRestore, false);
	assert.deepEqual(store.entries, [entry]);
	assert.equal(existsSync(intent.filePath), false);
});

test("reconcileMutationIntents does not touch a live operation", async () => {
	const paths = pathsFor("/live-intent");
	const store = await loadStashStore(paths);
	const intent = await beginAddIntent(paths, ENTRY_ID);
	const assetDir = writeAsset(paths);

	const didRecoverRestore = await reconcileMutationIntents(paths, store);

	assert.equal(didRecoverRestore, false);
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

test("reconcileMutationIntents removes assets owned by a stale generation on the current pid", async () => {
	const paths = pathsFor("/stale-generation-add");
	const store = await loadStashStore(paths);
	const intent = await beginAddIntent(paths, ENTRY_ID, STALE_GENERATION_OWNER);
	const assetDir = writeAsset(paths);

	const didRecoverRestore = await reconcileMutationIntents(paths, store);

	assert.equal(didRecoverRestore, false);
	assert.equal(existsSync(assetDir), false);
	assert.equal(existsSync(intent.filePath), false);
});

test("reconcileMutationIntents recovers a dead legacy owner without generation", async () => {
	const paths = pathsFor("/legacy-owner-add");
	const store = await loadStashStore(paths);
	const intent = await beginAddIntent(paths, ENTRY_ID, DEAD_OWNER);
	const raw = JSON.parse(readFileSync(intent.filePath, "utf8")) as {
		owner: { generation?: string };
	};
	delete raw.owner.generation;
	writeFileSync(intent.filePath, `${JSON.stringify(raw, null, 2)}\n`);
	const assetDir = writeAsset(paths);

	const didRecoverRestore = await reconcileMutationIntents(paths, store);

	assert.equal(didRecoverRestore, false);
	assert.equal(existsSync(assetDir), false);
	assert.equal(existsSync(intent.filePath), false);
});
