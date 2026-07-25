// StashStore: on-disk CRUD for stash entries, scoped to one worktree.
//
// Entries are stored newest-first (entries[0] is stash@{0}), mirroring git's
// index-0-is-tip convention. Every mutation re-reads the file inside an
// exclusive mkdir lock so two pi processes in the same worktree cannot lose
// updates via a read-modify-write race. Writes are atomic (temp + rename) with
// tight 0o600/0o700 permissions because stashed prompts may contain sensitive
// drafts. A corrupt file is quarantined rather than blindly overwritten, so a
// hand-edit mistake never silently destroys saved stashes.

import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { StashPaths } from "./paths.ts";
import {
	assertSafeEntryId,
	type Clock,
	createEmptyStashFile,
	createNewId,
	isRecord,
	parseStashFile,
	type ResolvedEntry,
	resolveBySelector,
	STASH_SCHEMA_VERSION,
	type StashEntry,
	type StashFile,
} from "./types.ts";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 30_000;
const LOCK_OWNER_FILE = "owner.json";
const LOCK_RECLAIM_SUFFIX = ".reclaim";
const ACTIVE_CLEANUP_MESSAGE = "active stash id queued for cleanup";
const DUPLICATE_STASH_ID_MESSAGE = "duplicate stash id";
const INVALID_ASSET_COUNT_MESSAGE = "invalid asset count";
const PENDING_STASH_ID_MESSAGE = "stash id pending asset cleanup";

type LockOwner = {
	pid: number;
	host: string;
	token: string;
	createdAt: string;
};

export type AddEntryInput = {
	text: string;
	message?: string;
	assetCount?: number;
	/** Older asset ids transferred into this entry and safe to remove after commit. */
	cleanupIds?: readonly string[];
	/** Caller-supplied id; generated when omitted. Lets a caller stage image
	 * assets into assetDir(id) before the entry is persisted. */
	id?: string;
};

export type LoadResult =
	| { kind: "ready"; file: StashFile; migratedFrom?: number }
	| { kind: "corrupt"; quarantinedTo?: string }
	| { kind: "unsupported"; schemaVersion: number };

export type StashWriter = (filePath: string, file: StashFile) => Promise<void>;

export class StashStore {
	private file: StashFile;
	private unsupportedSchemaVersion: number | undefined;
	private readonly stashFile: string;

	constructor(
		private readonly paths: StashPaths,
		loaded: LoadResult,
		private readonly now: Clock = Date.now,
		private readonly write: StashWriter = writeStashFile,
	) {
		this.file =
			loaded.kind === "ready" ? loaded.file : createEmptyStashFile(paths.sanitized, now());
		this.unsupportedSchemaVersion =
			loaded.kind === "unsupported" ? loaded.schemaVersion : undefined;
		this.stashFile = paths.stashFile;
	}

	get entries(): readonly StashEntry[] {
		return this.file.entries;
	}

	get entryCount(): number {
		return this.file.entries.length;
	}

	get pendingAssetCleanupIds(): readonly string[] {
		return this.file.pendingAssetCleanup;
	}

	async refresh(): Promise<void> {
		await withStashLock(this.stashFile, () => this.reloadFresh());
	}

	resolve(selector: string | undefined): ResolvedEntry | undefined {
		return resolveBySelector(this.file.entries, selector);
	}

	async add(input: AddEntryInput): Promise<StashEntry> {
		const id = input.id ?? createNewId();
		assertSafeEntryId(id);
		assertSafeAssetCount(input.assetCount);
		const cleanupIds = [...(input.cleanupIds ?? [])];
		for (const cleanupId of cleanupIds) assertSafeEntryId(cleanupId);
		return withStashLock(this.stashFile, async () => {
			await this.reloadFresh();
			this.assertWritable();
			assertAvailableOwnership(this.file, id, cleanupIds);
			const entry: StashEntry = {
				id,
				text: input.text,
				createdAt: this.now(),
			};
			if (input.message !== undefined && input.message.trim().length > 0) {
				entry.message = input.message.trim();
			}
			if (input.assetCount !== undefined && input.assetCount > 0) {
				entry.assetCount = input.assetCount;
			}
			const nextFile = {
				...this.file,
				updatedAt: entry.createdAt,
				entries: [entry, ...this.file.entries],
				pendingAssetCleanup: mergeCleanupIds(this.file.pendingAssetCleanup, cleanupIds),
			};
			await this.write(this.stashFile, nextFile);
			this.file = nextFile;
			return entry;
		});
	}

	async pop(
		selector: string | undefined,
		beforeRemove?: (resolved: ResolvedEntry) => boolean,
	): Promise<ResolvedEntry | undefined> {
		return this.remove(selector, false, beforeRemove);
	}

	async drop(selector: string | undefined): Promise<ResolvedEntry | undefined> {
		return this.remove(selector, true);
	}

	async completeAssetCleanup(id: string): Promise<void> {
		assertSafeEntryId(id);
		await withStashLock(this.stashFile, async () => {
			await this.reloadFresh();
			this.assertWritable();
			if (!this.file.pendingAssetCleanup.includes(id)) return;
			const nextFile = {
				...this.file,
				updatedAt: this.now(),
				pendingAssetCleanup: this.file.pendingAssetCleanup.filter((cleanupId) => cleanupId !== id),
			};
			await this.write(this.stashFile, nextFile);
			this.file = nextFile;
		});
	}

	async clear(): Promise<string[]> {
		return withStashLock(this.stashFile, async () => {
			await this.reloadFresh();
			this.assertWritable();
			const removedIds = this.file.entries.map((entry) => entry.id);
			const nextFile = {
				...createEmptyStashFile(this.paths.sanitized, this.now()),
				updatedAt: this.now(),
				pendingAssetCleanup: mergeCleanupIds(this.file.pendingAssetCleanup, removedIds),
			};
			await this.write(this.stashFile, nextFile);
			this.file = nextFile;
			return removedIds;
		});
	}

	private async remove(
		selector: string | undefined,
		queueAssetCleanup: boolean,
		beforeRemove?: (resolved: ResolvedEntry) => boolean,
	): Promise<ResolvedEntry | undefined> {
		return withStashLock(this.stashFile, async () => {
			await this.reloadFresh();
			this.assertWritable();
			const resolved = resolveBySelector(this.file.entries, selector);
			if (!resolved || (beforeRemove && !beforeRemove(resolved))) return undefined;
			const nextFile = {
				...this.file,
				updatedAt: this.now(),
				entries: this.file.entries.filter((_, index) => index !== resolved.index),
				pendingAssetCleanup: queueAssetCleanup
					? mergeCleanupIds(this.file.pendingAssetCleanup, [resolved.entry.id])
					: this.file.pendingAssetCleanup,
			};
			await this.write(this.stashFile, nextFile);
			this.file = nextFile;
			return resolved;
		});
	}

	private async reloadFresh(): Promise<void> {
		const loaded = await readCurrentStashFile(
			this.stashFile,
			this.paths.sanitized,
			this.now(),
			this.write,
		);
		if (loaded.kind === "ready") {
			this.file = loaded.file;
			this.unsupportedSchemaVersion = undefined;
		} else if (loaded.kind === "unsupported") {
			this.unsupportedSchemaVersion = loaded.schemaVersion;
		} else {
			this.file = createEmptyStashFile(this.paths.sanitized, this.now());
			this.unsupportedSchemaVersion = undefined;
		}
		// Corrupt input is quarantined and replaced with a fresh in-memory file so
		// later writes cannot resurrect entries from the invalidated snapshot.
	}

	private assertWritable(): void {
		if (this.unsupportedSchemaVersion !== undefined) {
			throw new Error(`unsupported stash schema version ${this.unsupportedSchemaVersion}`);
		}
	}
}

function assertAvailableOwnership(
	file: StashFile,
	entryId: string,
	cleanupIds: readonly string[],
): void {
	if (file.entries.some((entry) => entry.id === entryId)) {
		throw new Error(DUPLICATE_STASH_ID_MESSAGE);
	}
	if (file.pendingAssetCleanup.includes(entryId)) {
		throw new Error(PENDING_STASH_ID_MESSAGE);
	}
	const activeIds = new Set(file.entries.map((entry) => entry.id));
	if (cleanupIds.includes(entryId) || cleanupIds.some((id) => activeIds.has(id))) {
		throw new Error(ACTIVE_CLEANUP_MESSAGE);
	}
}

function assertSafeAssetCount(value: number | undefined): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
		throw new Error(INVALID_ASSET_COUNT_MESSAGE);
	}
}

function mergeCleanupIds(current: readonly string[], added: readonly string[]): string[] {
	return [...new Set([...current, ...added])];
}

export async function loadStashStore(
	paths: StashPaths,
	now: Clock = Date.now,
	write: StashWriter = writeStashFile,
): Promise<StashStore> {
	const loaded = await withStashLock(paths.stashFile, () =>
		readCurrentStashFile(paths.stashFile, paths.sanitized, now, write),
	);
	return new StashStore(paths, loaded, now, write);
}

async function readCurrentStashFile(
	filePath: string,
	cwdKey: string,
	now: number | Clock,
	write: StashWriter,
): Promise<LoadResult> {
	const loaded = await readStashFile(filePath, cwdKey, now);
	if (loaded.kind !== "ready" || loaded.migratedFrom === undefined) return loaded;
	await write(filePath, loaded.file);
	return { kind: "ready", file: loaded.file };
}

async function readStashFile(
	filePath: string,
	cwdKey: string,
	now: number | Clock,
): Promise<LoadResult> {
	const timestamp = typeof now === "number" ? now : now();
	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return { kind: "ready", file: createEmptyStashFile(cwdKey, timestamp) };
		}
		throw error;
	}

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return await quarantineCorrupt(filePath);
	}
	const parsed = parseStashFile(raw);
	if (parsed?.file.cwd === cwdKey) {
		return { kind: "ready", file: parsed.file, migratedFrom: parsed.migratedFrom };
	}
	if (
		isRecord(raw) &&
		typeof raw.schemaVersion === "number" &&
		Number.isSafeInteger(raw.schemaVersion) &&
		raw.schemaVersion > STASH_SCHEMA_VERSION
	) {
		return { kind: "unsupported", schemaVersion: raw.schemaVersion };
	}
	return await quarantineCorrupt(filePath);
}

async function quarantineCorrupt(filePath: string): Promise<LoadResult> {
	// Move the bad file aside so the next write starts clean without destroying
	// what the user might want to recover manually.
	const quarantinedTo = `${filePath}.corrupt-${Date.now()}`;
	try {
		await rename(filePath, quarantinedTo);
		return { kind: "corrupt", quarantinedTo };
	} catch {
		// If even rename fails (permissions, vanished), fall back to empty.
		return { kind: "corrupt" };
	}
}

async function writeStashFile(filePath: string, file: StashFile): Promise<void> {
	await ensurePrivateDirectory(path.dirname(filePath));
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	const data = `${JSON.stringify(file, null, 2)}\n`;
	try {
		await writeFile(tempPath, data, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
		await chmod(tempPath, PRIVATE_FILE_MODE);
		await rename(tempPath, filePath);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
	await chmod(directory, PRIVATE_DIR_MODE);
}

async function withStashLock<Result>(
	filePath: string,
	operation: () => Promise<Result>,
): Promise<Result> {
	await ensurePrivateDirectory(path.dirname(filePath));
	const lockPath = `${filePath}.lock`;
	const token = await acquireStashLock(lockPath);
	try {
		return await operation();
	} finally {
		await releaseStashLock(lockPath, token);
	}
}

async function acquireStashLock(lockPath: string): Promise<string> {
	const startedAt = Date.now();
	const token = createNewId();
	for (;;) {
		try {
			await mkdir(lockPath, { mode: PRIVATE_DIR_MODE });
			try {
				await chmod(lockPath, PRIVATE_DIR_MODE);
				await writeLockOwner(lockPath, token);
			} catch (error) {
				await rm(lockPath, { force: true, recursive: true });
				throw error;
			}
			return token;
		} catch (error) {
			if (!hasErrorCode(error, "EEXIST")) throw error;
			if (await reclaimStaleLock(lockPath)) continue;
			if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
				throw new Error(`timed out waiting for pi-stash lock ${lockPath}`);
			}
			await delay(LOCK_RETRY_MS);
		}
	}
}

async function writeLockOwner(lockPath: string, token: string): Promise<void> {
	const owner: LockOwner = {
		pid: process.pid,
		host: hostname(),
		token,
		createdAt: new Date().toISOString(),
	};
	const ownerPath = path.join(lockPath, LOCK_OWNER_FILE);
	await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, {
		encoding: "utf8",
		mode: PRIVATE_FILE_MODE,
	});
	await chmod(ownerPath, PRIVATE_FILE_MODE);
}

async function readLockOwner(lockPath: string): Promise<LockOwner | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(path.join(lockPath, LOCK_OWNER_FILE), "utf8"));
		if (!isLockOwner(value)) return undefined;
		return value;
	} catch {
		return undefined;
	}
}

function isLockOwner(value: unknown): value is LockOwner {
	return (
		typeof value === "object" &&
		value !== null &&
		"pid" in value &&
		Number.isSafeInteger(value.pid) &&
		"host" in value &&
		typeof value.host === "string" &&
		"token" in value &&
		typeof value.token === "string" &&
		"createdAt" in value &&
		typeof value.createdAt === "string"
	);
}

async function releaseStashLock(lockPath: string, token: string): Promise<void> {
	const owner = await readLockOwner(lockPath);
	if (owner?.token === token) await rm(lockPath, { force: true, recursive: true });
}

async function reclaimStaleLock(lockPath: string): Promise<boolean> {
	const reclaimPath = `${lockPath}${LOCK_RECLAIM_SUFFIX}`;
	const reclaimToken = await acquireReclaimGuard(reclaimPath);
	if (!reclaimToken) return false;
	try {
		// Recheck only after winning the atomic reclamation guard. Without this
		// guard, a second reclaimer could delete a new owner's replacement lock.
		if (!(await isStaleAbandonedLock(lockPath))) return false;
		await rm(lockPath, { force: true, recursive: true });
		return true;
	} finally {
		await releaseStashLock(reclaimPath, reclaimToken);
	}
}

async function acquireReclaimGuard(reclaimPath: string): Promise<string | undefined> {
	const token = createNewId();
	try {
		await mkdir(reclaimPath, { mode: PRIVATE_DIR_MODE });
		try {
			await chmod(reclaimPath, PRIVATE_DIR_MODE);
			await writeLockOwner(reclaimPath, token);
		} catch (error) {
			await rm(reclaimPath, { force: true, recursive: true });
			throw error;
		}
		return token;
	} catch (error) {
		if (!hasErrorCode(error, "EEXIST")) throw error;
		// A crashed reclaimer must not permanently block every future writer.
		if (await isStaleAbandonedLock(reclaimPath)) {
			await rm(reclaimPath, { force: true, recursive: true });
		}
		return undefined;
	}
}

async function isStaleAbandonedLock(lockPath: string): Promise<boolean> {
	const stats = await stat(lockPath).catch(() => undefined);
	if (!stats || Date.now() - stats.mtimeMs <= LOCK_STALE_MS) return false;
	const owner = await readLockOwner(lockPath);
	return !owner || (owner.host === hostname() && !isProcessAlive(owner.pid));
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !hasErrorCode(error, "ESRCH");
	}
}

function hasErrorCode(value: unknown, code: string): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		(value as { code: unknown }).code === code
	);
}

export { STASH_SCHEMA_VERSION };
