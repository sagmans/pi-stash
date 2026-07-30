// StashStore: on-disk CRUD for stash entries, scoped to one worktree.
//
// Entries are stored newest-first (entries[0] is stash@{0}), mirroring git's
// index-0-is-tip convention. Every mutation re-reads the file inside an
// exclusive mkdir lock so two pi processes in the same worktree cannot lose
// updates via a read-modify-write race. Writes are atomic (temp + rename) with
// tight 0o600/0o700 permissions because stashed drafts may contain sensitive
// text. A corrupt file is quarantined rather than blindly overwritten, so a
// hand-edit mistake never silently destroys saved stashes.

import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import type { StashPaths } from "./paths.ts";
import {
	assertPrivateDirectory,
	ensurePrivateDirectory,
	hasErrorCode,
	PRIVATE_DIR_MODE,
	type PrivateTextFile,
	pathExists,
	quarantinePrivateFile,
	readPrivateTextFile,
	removePrivateDirectory,
	syncPrivateDirectory,
	writePrivateFileExclusive,
} from "./private-fs.ts";
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

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 30_000;
const LOCK_OWNER_FILE = "owner.json";
const LOCK_RECLAIM_SUFFIX = ".reclaim";
const PROC_STAT_START_TIME_INDEX = 19;
const execFileAsync = promisify(execFile);
const PROCESS_GENERATION_FALLBACK = `opaque:${createNewId()}`;
let selfProcessGeneration: Promise<string> | undefined;
const ACTIVE_CLEANUP_MESSAGE = "active stash id queued for cleanup";
const DUPLICATE_STASH_ID_MESSAGE = "duplicate stash id";
const INVALID_ASSET_COUNT_MESSAGE = "invalid asset count";
const INVALID_CREATED_AT_MESSAGE = "invalid stash creation time";
const PENDING_STASH_ID_MESSAGE = "stash id pending asset cleanup";
const COMMITTED_MUTATION_ERROR_MESSAGE = "stash mutation committed but lock release failed";
const MUTATION_AND_UNLOCK_ERROR_MESSAGE = "stash mutation and lock release both failed";
const LOCK_GENERATION_CHANGED_MESSAGE = "stash lock generation changed before release";
const UNSUPPORTED_SCHEMA_GUIDANCE =
	"Upgrade pi-stash before using this stash, or export the stash file for safe recovery.";

type LockOwner = {
	pid: number;
	host: string;
	token: string;
	generation: string;
	createdAt: string;
};

type LockState =
	| { kind: "missing" }
	| { kind: "dead"; owner: LockOwner }
	| { kind: "live"; owner: LockOwner }
	| { kind: "uncertain"; owner: LockOwner }
	| { kind: "malformed" };

export type AddEntryInput = {
	text: string;
	message?: string;
	assetCount?: number;
	/** Older asset ids transferred into this entry and safe to remove after commit. */
	cleanupIds?: readonly string[];
	/** Caller-supplied id; generated when omitted. Lets a caller stage image
	 * assets into assetDir(id) before the entry is persisted. */
	id?: string;
	/** Original timestamp used only when crash reconciliation restores an entry. */
	createdAt?: number;
};

export type LoadResult =
	| { kind: "ready"; file: StashFile; migratedFrom?: number; durabilityWarning?: string }
	| { kind: "corrupt"; quarantinedTo?: string }
	| { kind: "unsupported"; schemaVersion: number };

export type StashWriteOutcome = {
	committed: true;
	cleanupError: unknown;
};

export type StashWriter = (filePath: string, file: StashFile) => Promise<void | StashWriteOutcome>;

export type RestoredAssetCleanup = {
	queued: string[];
	retained: string[];
};

export class CommittedMutationError<Result> extends Error {
	readonly committed = true;
	readonly result: Result;
	readonly cleanupError: unknown;

	constructor(result: Result, cleanupError: unknown) {
		super(COMMITTED_MUTATION_ERROR_MESSAGE, { cause: cleanupError });
		this.name = "CommittedMutationError";
		this.result = result;
		this.cleanupError = cleanupError;
	}
}

export class UnsupportedStashSchemaError extends Error {
	readonly detectedVersion: number;
	readonly supportedVersion: number;

	constructor(detectedVersion: number, supportedVersion = STASH_SCHEMA_VERSION) {
		super(
			`pi-stash unavailable: stash data uses schema version ${detectedVersion}; this extension supports schema versions through ${supportedVersion}. ${UNSUPPORTED_SCHEMA_GUIDANCE}`,
		);
		this.name = "UnsupportedStashSchemaError";
		this.detectedVersion = detectedVersion;
		this.supportedVersion = supportedVersion;
	}
}

/** Typed so concurrent reconcilers can recognize a benign duplicate recovery. */
export class DuplicateStashEntryError extends Error {
	constructor() {
		super(DUPLICATE_STASH_ID_MESSAGE);
		this.name = "DuplicateStashEntryError";
	}
}

export class StashStore {
	private file: StashFile;
	private corruptRecoveryPath: string | undefined;
	private durabilityWarning: string | undefined;
	private readonly stashFile: string;
	private readonly paths: StashPaths;
	private readonly now: Clock;
	private readonly write: StashWriter;

	constructor(
		paths: StashPaths,
		loaded: LoadResult,
		now: Clock = Date.now,
		write: StashWriter = writeStashFile,
	) {
		if (loaded.kind === "unsupported") {
			throw new UnsupportedStashSchemaError(loaded.schemaVersion);
		}
		this.paths = paths;
		this.now = now;
		this.write = write;
		this.file =
			loaded.kind === "ready" ? loaded.file : createEmptyStashFile(paths.sanitized, now());
		this.corruptRecoveryPath = loaded.kind === "corrupt" ? loaded.quarantinedTo : undefined;
		this.durabilityWarning = loaded.kind === "ready" ? loaded.durabilityWarning : undefined;
		this.stashFile = paths.stashFile;
	}

	get entries(): readonly StashEntry[] {
		return this.file.entries;
	}

	get entryCount(): number {
		return this.file.entries.length;
	}

	get restoredAssetLeaseIds(): readonly string[] {
		return this.file.restoredAssetLeases;
	}

	get pendingAssetCleanupIds(): readonly string[] {
		return this.file.pendingAssetCleanup;
	}

	takeCorruptRecoveryPath(): string | undefined {
		const recoveryPath = this.corruptRecoveryPath;
		this.corruptRecoveryPath = undefined;
		return recoveryPath;
	}

	/** One-shot warning from a committed write whose directory sync failed. */
	takeDurabilityWarning(): string | undefined {
		const warning = this.durabilityWarning;
		this.durabilityWarning = undefined;
		return warning;
	}

	async refresh(): Promise<void> {
		await withStashLock(this.stashFile, () => this.reloadFresh());
	}

	async add(input: AddEntryInput): Promise<StashEntry> {
		const id = input.id ?? createNewId();
		assertSafeEntryId(id);
		assertSafeAssetCount(input.assetCount);
		assertSafeCreatedAt(input.createdAt);
		const cleanupIds = [...(input.cleanupIds ?? [])];
		for (const cleanupId of cleanupIds) assertSafeEntryId(cleanupId);
		return withStashMutationLock(this.stashFile, async () => {
			await this.reloadFresh();
			assertAvailableOwnership(this.file, id, cleanupIds);
			const entry: StashEntry = {
				id,
				text: input.text,
				createdAt: input.createdAt ?? this.now(),
			};
			if (input.message !== undefined && input.message.trim().length > 0) {
				entry.message = input.message.trim();
			}
			if (input.assetCount !== undefined && input.assetCount > 0) {
				entry.assetCount = input.assetCount;
			}
			const transferredIds = new Set([id, ...cleanupIds]);
			const nextFile = {
				...this.file,
				updatedAt: entry.createdAt,
				entries: [entry, ...this.file.entries],
				restoredAssetLeases: this.file.restoredAssetLeases.filter(
					(leaseId) => !transferredIds.has(leaseId),
				),
				pendingAssetCleanup: mergeCleanupIds(this.file.pendingAssetCleanup, cleanupIds),
			};
			return this.persistMutation(nextFile, entry);
		});
	}

	async pop(
		selector: string | undefined,
		beforeRemove?: (resolved: ResolvedEntry) => boolean | Promise<boolean>,
	): Promise<ResolvedEntry | undefined> {
		return this.remove(selector, "lease", beforeRemove);
	}

	async drop(selector: string | undefined): Promise<ResolvedEntry | undefined> {
		return this.remove(selector, "cleanup");
	}

	async queueRestoredAssetCleanup(retainIds: readonly string[]): Promise<RestoredAssetCleanup> {
		for (const id of retainIds) assertSafeEntryId(id);
		return withStashMutationLock(this.stashFile, async () => {
			await this.reloadFresh();
			const retainedSet = new Set(retainIds);
			const retained = this.file.restoredAssetLeases.filter((id) => retainedSet.has(id));
			const queued = this.file.restoredAssetLeases.filter((id) => !retainedSet.has(id));
			if (queued.length === 0) return { queued, retained };
			const nextFile = {
				...this.file,
				updatedAt: this.now(),
				restoredAssetLeases: retained,
				pendingAssetCleanup: mergeCleanupIds(this.file.pendingAssetCleanup, queued),
			};
			return this.persistMutation(nextFile, { queued, retained });
		});
	}

	async completeAssetCleanup(id: string): Promise<void> {
		assertSafeEntryId(id);
		await withStashMutationLock(this.stashFile, async () => {
			await this.reloadFresh();
			if (!this.file.pendingAssetCleanup.includes(id)) return;
			const nextFile = {
				...this.file,
				updatedAt: this.now(),
				pendingAssetCleanup: this.file.pendingAssetCleanup.filter((cleanupId) => cleanupId !== id),
			};
			await this.persistMutation(nextFile, undefined);
		});
	}

	async clear(): Promise<string[]> {
		return withStashMutationLock(this.stashFile, async () => {
			await this.reloadFresh();
			const removedIds = this.file.entries.map((entry) => entry.id);
			const nextFile = {
				...createEmptyStashFile(this.paths.sanitized, this.now()),
				updatedAt: this.now(),
				pendingAssetCleanup: mergeCleanupIds(this.file.pendingAssetCleanup, [
					...removedIds,
					...this.file.restoredAssetLeases,
				]),
			};
			return this.persistMutation(nextFile, removedIds);
		});
	}

	private async remove(
		selector: string | undefined,
		assetDisposition: "cleanup" | "lease",
		beforeRemove?: (resolved: ResolvedEntry) => boolean | Promise<boolean>,
	): Promise<ResolvedEntry | undefined> {
		return withStashMutationLock(this.stashFile, async () => {
			await this.reloadFresh();
			const resolved = resolveBySelector(this.file.entries, selector);
			if (!resolved || (beforeRemove && !(await beforeRemove(resolved)))) return undefined;
			const ownsAssets = (resolved.entry.assetCount ?? 0) > 0;
			const nextFile = {
				...this.file,
				updatedAt: this.now(),
				entries: this.file.entries.filter((_, index) => index !== resolved.index),
				restoredAssetLeases:
					assetDisposition === "lease" && ownsAssets
						? mergeCleanupIds(this.file.restoredAssetLeases, [resolved.entry.id])
						: this.file.restoredAssetLeases,
				pendingAssetCleanup:
					assetDisposition === "cleanup"
						? mergeCleanupIds(this.file.pendingAssetCleanup, [resolved.entry.id])
						: this.file.pendingAssetCleanup,
			};
			return this.persistMutation(nextFile, resolved);
		});
	}

	private async persistMutation<Result>(nextFile: StashFile, result: Result): Promise<Result> {
		const outcome = await this.write(this.stashFile, nextFile);
		this.file = nextFile;
		if (outcome?.committed) {
			throw new CommittedMutationError(result, outcome.cleanupError);
		}
		return result;
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
			if (loaded.durabilityWarning !== undefined) {
				this.durabilityWarning = loaded.durabilityWarning;
			}
		} else if (loaded.kind === "unsupported") {
			throw new UnsupportedStashSchemaError(loaded.schemaVersion);
		} else {
			this.file = createEmptyStashFile(this.paths.sanitized, this.now());
			this.corruptRecoveryPath = loaded.quarantinedTo;
		}
		// Corrupt input is quarantined and replaced with a fresh in-memory file so
		// later writes cannot resurrect entries from the invalidated snapshot.
	}
}

function assertAvailableOwnership(
	file: StashFile,
	entryId: string,
	cleanupIds: readonly string[],
): void {
	if (file.entries.some((entry) => entry.id === entryId)) {
		throw new DuplicateStashEntryError();
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

function assertSafeCreatedAt(value: number | undefined): void {
	if (value !== undefined && (!Number.isFinite(value) || Number.isNaN(new Date(value).getTime()))) {
		throw new Error(INVALID_CREATED_AT_MESSAGE);
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
	if (loaded.kind === "unsupported") {
		throw new UnsupportedStashSchemaError(loaded.schemaVersion);
	}
	return new StashStore(paths, loaded, now, write);
}

/** Coordinate migration with both legacy and configured-root store processes. */
export function withStashFileLock<Result>(
	filePath: string,
	operation: () => Promise<Result>,
): Promise<Result> {
	return withStashLock(filePath, operation);
}

async function readCurrentStashFile(
	filePath: string,
	cwdKey: string,
	now: number | Clock,
	write: StashWriter,
): Promise<LoadResult> {
	const loaded = await readStashFile(filePath, cwdKey, now);
	if (loaded.kind !== "ready" || loaded.migratedFrom === undefined) return loaded;
	// The upgrade already committed when only the directory sync fails: reporting
	// it as an error would falsely disable pi-stash over readable data. Preserve
	// the durability signal as a one-shot warning instead of failing the load.
	const outcome = await write(filePath, loaded.file);
	if (outcome?.committed) {
		const durabilityWarning =
			outcome.cleanupError instanceof Error
				? outcome.cleanupError.message
				: String(outcome.cleanupError);
		return { kind: "ready", file: loaded.file, durabilityWarning };
	}
	return { kind: "ready", file: loaded.file };
}

async function readStashFile(
	filePath: string,
	cwdKey: string,
	now: number | Clock,
): Promise<LoadResult> {
	const timestamp = typeof now === "number" ? now : now();
	let source: PrivateTextFile;
	try {
		source = await readPrivateTextFile(filePath);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return { kind: "ready", file: createEmptyStashFile(cwdKey, timestamp) };
		}
		throw error;
	}

	let raw: unknown;
	try {
		raw = JSON.parse(source.text);
	} catch {
		return await quarantineCorrupt(filePath, source.identity);
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
	return await quarantineCorrupt(filePath, source.identity);
}

async function quarantineCorrupt(
	filePath: string,
	identity: PrivateTextFile["identity"],
): Promise<LoadResult> {
	// Hard-link reservation preserves earlier evidence instead of relying on
	// rename's platform-specific overwrite behavior.
	const quarantinedTo = await quarantinePrivateFile(filePath, identity, `corrupt-${Date.now()}`);
	return { kind: "corrupt", quarantinedTo };
}

export async function writeStashFile(
	filePath: string,
	file: StashFile,
	syncDirectory: typeof syncPrivateDirectory = syncPrivateDirectory,
): Promise<void | StashWriteOutcome> {
	await ensurePrivateDirectory(path.dirname(filePath));
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	const data = `${JSON.stringify(file, null, 2)}\n`;
	let tempCreated = false;
	try {
		await writePrivateFileExclusive(tempPath, data);
		tempCreated = true;
		await rename(tempPath, filePath);
		tempCreated = false;
	} catch (error) {
		if (tempCreated) await rm(tempPath, { force: true });
		throw error;
	}
	try {
		await syncDirectory(path.dirname(filePath));
	} catch (cleanupError) {
		return { committed: true, cleanupError };
	}
}

function withStashMutationLock<Result>(
	filePath: string,
	operation: () => Promise<Result>,
): Promise<Result> {
	return withStashLock(filePath, operation, true);
}

async function withStashLock<Result>(
	filePath: string,
	operation: () => Promise<Result>,
	mutation = false,
): Promise<Result> {
	await ensurePrivateDirectory(path.dirname(filePath));
	const lockPath = `${filePath}.lock`;
	const owner = await acquireStashLock(lockPath);
	let result: Result;
	try {
		result = await operation();
	} catch (operationError) {
		try {
			await releaseStashLock(lockPath, owner);
		} catch (cleanupError) {
			if (operationError instanceof CommittedMutationError) {
				throw new CommittedMutationError(
					operationError.result,
					new AggregateError(
						[operationError.cleanupError, cleanupError],
						MUTATION_AND_UNLOCK_ERROR_MESSAGE,
					),
				);
			}
			throw new AggregateError([operationError, cleanupError], MUTATION_AND_UNLOCK_ERROR_MESSAGE);
		}
		throw operationError;
	}
	try {
		await releaseStashLock(lockPath, owner);
	} catch (cleanupError) {
		if (mutation) throw new CommittedMutationError(result, cleanupError);
		throw cleanupError;
	}
	return result;
}

async function acquireStashLock(lockPath: string): Promise<LockOwner> {
	const startedAt = Date.now();
	for (;;) {
		try {
			await mkdir(lockPath, { mode: PRIVATE_DIR_MODE });
			try {
				const reclaimPath = `${lockPath}${LOCK_RECLAIM_SUFFIX}`;
				if (await pathExists(reclaimPath)) {
					if (await isRecoverableLock(reclaimPath)) {
						// A reclaimer crashed after removing the old lock but before
						// releasing its guard. The lock dir is already ours, so clearing
						// the provably dead guard cannot disturb live reclaim work;
						// without this the orphaned guard would wedge acquisition forever.
						await removePrivateDirectory(reclaimPath, "stash lock reclamation guard");
					} else {
						await rm(lockPath, { force: true, recursive: true });
						if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
							throw new Error(lockTimeoutMessage(reclaimPath, await inspectLockState(reclaimPath)));
						}
						await delay(LOCK_RETRY_MS);
						continue;
					}
				}
				await ensurePrivateDirectory(lockPath, "stash lock");
				return await writeLockOwner(lockPath);
			} catch (error) {
				await rm(lockPath, { force: true, recursive: true });
				throw error;
			}
		} catch (error) {
			if (!hasErrorCode(error, "EEXIST")) throw error;
			try {
				await assertPrivateDirectory(lockPath, "stash lock");
			} catch (validationError) {
				if (hasErrorCode(validationError, "ENOENT")) continue;
				throw validationError;
			}
			if (await reclaimAbandonedLock(lockPath)) continue;
			if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
				throw new Error(lockTimeoutMessage(lockPath, await inspectLockState(lockPath)));
			}
			await delay(LOCK_RETRY_MS);
		}
	}
}

async function writeLockOwner(lockPath: string): Promise<LockOwner> {
	const owner: LockOwner = {
		pid: process.pid,
		host: hostname(),
		token: createNewId(),
		generation: await readProcessGeneration(process.pid),
		createdAt: new Date().toISOString(),
	};
	const ownerPath = path.join(lockPath, LOCK_OWNER_FILE);
	await writePrivateFileExclusive(ownerPath, `${JSON.stringify(owner)}\n`);
	return owner;
}

async function readLockOwner(lockPath: string): Promise<LockOwner | undefined> {
	let text: string;
	try {
		await assertPrivateDirectory(lockPath, "stash lock");
		text = (await readPrivateTextFile(path.join(lockPath, LOCK_OWNER_FILE), "lock owner file"))
			.text;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
	try {
		const value: unknown = JSON.parse(text);
		return isLockOwner(value) ? value : undefined;
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
		"generation" in value &&
		typeof value.generation === "string" &&
		value.generation.length > 0 &&
		"createdAt" in value &&
		typeof value.createdAt === "string"
	);
}

async function releaseStashLock(lockPath: string, expected: LockOwner): Promise<void> {
	const owner = await readLockOwner(lockPath);
	if (!sameLockGeneration(owner, expected)) throw new Error(LOCK_GENERATION_CHANGED_MESSAGE);
	await rm(lockPath, { force: true, recursive: true });
}

async function reclaimAbandonedLock(lockPath: string): Promise<boolean> {
	const reclaimPath = `${lockPath}${LOCK_RECLAIM_SUFFIX}`;
	const reclaimOwner = await acquireReclaimGuard(reclaimPath);
	if (!reclaimOwner) return false;
	try {
		// New owners observe the guard before publishing their generation, while
		// this second check prevents an earlier contender from deleting a live lock.
		if (!(await isRecoverableLock(lockPath))) return false;
		await removePrivateDirectory(lockPath, "stash lock");
		return true;
	} finally {
		await releaseStashLock(reclaimPath, reclaimOwner);
	}
}

async function acquireReclaimGuard(reclaimPath: string): Promise<LockOwner | undefined> {
	try {
		await mkdir(reclaimPath, { mode: PRIVATE_DIR_MODE });
		try {
			await ensurePrivateDirectory(reclaimPath, "stash lock reclamation guard");
			return await writeLockOwner(reclaimPath);
		} catch (error) {
			await rm(reclaimPath, { force: true, recursive: true });
			throw error;
		}
	} catch (error) {
		if (!hasErrorCode(error, "EEXIST")) throw error;
		await assertPrivateDirectory(reclaimPath, "stash lock reclamation guard");
		if (await isRecoverableLock(reclaimPath)) {
			await removePrivateDirectory(reclaimPath, "stash lock reclamation guard");
		}
		return undefined;
	}
}

async function isRecoverableLock(lockPath: string): Promise<boolean> {
	let stats: Awaited<ReturnType<typeof assertPrivateDirectory>>;
	try {
		stats = await assertPrivateDirectory(lockPath, "stash lock");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	}
	const state = await inspectLockState(lockPath);
	if (state.kind === "dead") return true;
	return state.kind === "malformed" && Date.now() - stats.mtimeMs > LOCK_STALE_MS;
}

async function inspectLockState(lockPath: string): Promise<LockState> {
	const owner = await readLockOwner(lockPath);
	if (!owner) return (await pathExists(lockPath)) ? { kind: "malformed" } : { kind: "missing" };
	if (owner.host !== hostname()) return { kind: "uncertain", owner };
	if (!isProcessAlive(owner.pid)) return { kind: "dead", owner };
	const generation = await readProcessGeneration(owner.pid).catch(() => undefined);
	if (generation) {
		return generation === owner.generation ? { kind: "live", owner } : { kind: "dead", owner };
	}
	const stats = await assertPrivateDirectory(lockPath, "stash lock");
	return Date.now() - stats.mtimeMs <= LOCK_STALE_MS
		? { kind: "live", owner }
		: { kind: "uncertain", owner };
}

export async function readProcessGeneration(pid: number): Promise<string> {
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid process id");
	if (pid === process.pid) {
		selfProcessGeneration ??= readExternalProcessGeneration(pid).catch(
			() => PROCESS_GENERATION_FALLBACK,
		);
		return selfProcessGeneration;
	}
	return readExternalProcessGeneration(pid);
}

async function readExternalProcessGeneration(pid: number): Promise<string> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const commandEnd = stat.lastIndexOf(")");
		const fields =
			commandEnd >= 0
				? stat
						.slice(commandEnd + 2)
						.trim()
						.split(/\s+/u)
				: [];
		const startTime = fields[PROC_STAT_START_TIME_INDEX];
		if (startTime) return `proc:${startTime}`;
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) throw error;
	}
	const { stdout } = await execFileAsync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
		encoding: "utf8",
	});
	const startTime = stdout.trim();
	if (!startTime) throw new Error("process generation unavailable");
	return `ps:${startTime}`;
}

function sameLockGeneration(actual: LockOwner | undefined, expected: LockOwner): boolean {
	return actual?.token === expected.token && actual.generation === expected.generation;
}

function lockTimeoutMessage(lockPath: string, state: LockState): string {
	switch (state.kind) {
		case "live":
			return `timed out waiting for pi-stash lock ${lockPath}: live lock owner pid ${state.owner.pid}`;
		case "uncertain":
			return `timed out waiting for pi-stash lock ${lockPath}: uncertain lock owner pid ${state.owner.pid}`;
		case "malformed":
			return `timed out waiting for pi-stash lock ${lockPath}: malformed lock owner metadata`;
		case "dead":
			return `timed out recovering dead pi-stash lock ${lockPath}`;
		case "missing":
			return `timed out waiting for replaced pi-stash lock ${lockPath}`;
		default: {
			const exhaustive: never = state;
			return exhaustive;
		}
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !hasErrorCode(error, "ESRCH");
	}
}

export { STASH_SCHEMA_VERSION };
