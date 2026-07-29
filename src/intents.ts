// Durable mutation intents bridge filesystem work and stash metadata commits.
// Dead-owner reconciliation either removes uncommitted add assets or restores a
// draft removed before its editor handoff could be acknowledged.

import { readdir, rmdir, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import type { StashPaths } from "./paths.ts";
import {
	assertPrivateDirectory,
	ensurePrivateDirectory,
	hasErrorCode,
	readPrivateTextFile,
	removePrivateDirectory,
	syncPrivateDirectory,
	writePrivateFileExclusive,
} from "./private-fs.ts";
import type { StashStore } from "./store.ts";
import { createNewId, isRecord, isSafeEntryId, normalizeEntry, type StashEntry } from "./types.ts";

const INTENT_SCHEMA_VERSION = 1;
const INTENT_ROOT_SUFFIX = ".intents";
const INTENT_FILE_SUFFIX = ".json";
const MALFORMED_INTENT_MESSAGE = "malformed stash mutation intent";

export type MutationIntentOwner = {
	pid: number;
	host: string;
	startedAt: number;
	token: string;
};

type AddIntentData = {
	schemaVersion: typeof INTENT_SCHEMA_VERSION;
	kind: "add";
	id: string;
	owner: MutationIntentOwner;
};

type RestoreIntentData = {
	schemaVersion: typeof INTENT_SCHEMA_VERSION;
	kind: "restore";
	id: string;
	owner: MutationIntentOwner;
	entry: StashEntry;
};

type MutationIntentData = AddIntentData | RestoreIntentData;

export type MutationIntent = {
	filePath: string;
	data: MutationIntentData;
};

export async function beginAddIntent(
	paths: StashPaths,
	id: string,
	owner: MutationIntentOwner = currentOwner(),
): Promise<MutationIntent> {
	if (!isSafeEntryId(id)) throw new Error("invalid add intent id");
	return writeIntent(paths, { schemaVersion: INTENT_SCHEMA_VERSION, kind: "add", id, owner });
}

export async function beginRestoreIntent(
	paths: StashPaths,
	entry: StashEntry,
	owner: MutationIntentOwner = currentOwner(),
): Promise<MutationIntent> {
	const normalized = normalizeEntry(entry);
	if (!normalized) throw new Error("invalid restore intent entry");
	return writeIntent(paths, {
		schemaVersion: INTENT_SCHEMA_VERSION,
		kind: "restore",
		id: normalized.id,
		owner,
		entry: normalized,
	});
}

export async function completeIntent(intent: MutationIntent): Promise<void> {
	const root = path.dirname(intent.filePath);
	let intentRemoved = false;
	try {
		await unlink(intent.filePath);
		intentRemoved = true;
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) throw error;
	}
	if (intentRemoved) await syncPrivateDirectory(root, "stash mutation intent directory");
	try {
		await rmdir(root);
		await syncPrivateDirectory(path.dirname(root));
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTEMPTY")) throw error;
	}
}

export async function reconcileMutationIntents(
	paths: StashPaths,
	store: StashStore,
	remove: (assetDir: string) => Promise<void> = removePrivateDirectory,
): Promise<boolean> {
	let didRecoverRestore = false;
	const root = intentRoot(paths);
	try {
		await assertPrivateDirectory(root, "stash mutation intent directory");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	}
	await store.refresh();
	const entries = await readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(MALFORMED_INTENT_MESSAGE);
		const intent = await readIntent(path.join(root, entry.name));
		if (ownerMayBeLive(intent.data.owner)) continue;
		if (intent.data.kind === "add") {
			if (!store.entries.some((stashEntry) => stashEntry.id === intent.data.id)) {
				await remove(paths.assetDir(intent.data.id));
			}
			await completeIntent(intent);
			continue;
		}
		if (!store.entries.some((stashEntry) => stashEntry.id === intent.data.id)) {
			const restore = intent.data.entry;
			await store.add({
				id: restore.id,
				text: restore.text,
				createdAt: restore.createdAt,
				message: restore.message,
				assetCount: restore.assetCount,
			});
			didRecoverRestore = true;
		}
		await completeIntent(intent);
	}
	return didRecoverRestore;
}

async function writeIntent(paths: StashPaths, data: MutationIntentData): Promise<MutationIntent> {
	const root = intentRoot(paths);
	await ensurePrivateDirectory(root, "stash mutation intent directory");
	const filePath = path.join(root, `${data.kind}-${data.id}${INTENT_FILE_SUFFIX}`);
	await writePrivateFileExclusive(filePath, `${JSON.stringify(data, null, 2)}\n`);
	await syncPrivateDirectory(root, "stash mutation intent directory");
	return { filePath, data };
}

async function readIntent(filePath: string): Promise<MutationIntent> {
	const text = (await readPrivateTextFile(filePath, "stash mutation intent file")).text;
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error(MALFORMED_INTENT_MESSAGE);
	}
	if (!isMutationIntentData(raw)) throw new Error(MALFORMED_INTENT_MESSAGE);
	const expectedName = `${raw.kind}-${raw.id}${INTENT_FILE_SUFFIX}`;
	if (path.basename(filePath) !== expectedName) throw new Error(MALFORMED_INTENT_MESSAGE);
	return { filePath, data: raw };
}

function isMutationIntentData(value: unknown): value is MutationIntentData {
	if (
		!isRecord(value) ||
		value.schemaVersion !== INTENT_SCHEMA_VERSION ||
		(value.kind !== "add" && value.kind !== "restore") ||
		typeof value.id !== "string" ||
		!isSafeEntryId(value.id) ||
		!isOwner(value.owner)
	) {
		return false;
	}
	if (value.kind === "add") return value.entry === undefined;
	const entry = normalizeEntry(value.entry);
	return !!entry && entry.id === value.id;
}

function isOwner(value: unknown): value is MutationIntentOwner {
	return (
		isRecord(value) &&
		Number.isSafeInteger(value.pid) &&
		typeof value.pid === "number" &&
		value.pid > 0 &&
		typeof value.host === "string" &&
		Number.isFinite(value.startedAt) &&
		typeof value.startedAt === "number" &&
		typeof value.token === "string" &&
		value.token.length > 0
	);
}

function currentOwner(): MutationIntentOwner {
	return {
		pid: process.pid,
		host: hostname(),
		startedAt: Date.now(),
		token: createNewId(),
	};
}

function ownerMayBeLive(owner: MutationIntentOwner): boolean {
	if (owner.host !== hostname()) return true;
	try {
		process.kill(owner.pid, 0);
		return true;
	} catch (error) {
		return !hasErrorCode(error, "ESRCH");
	}
}

function intentRoot(paths: StashPaths): string {
	return `${paths.stashFile}${INTENT_ROOT_SUFFIX}`;
}
