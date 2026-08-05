// StashStore: on-disk CRUD for stash entries, scoped to one worktree.
//
// Entries are stored newest-first (entries[0] is stash@{0}), mirroring git's
// index-0-is-tip convention. Every mutation re-reads the file inside an
// exclusive mkdir lock so two pi processes in the same worktree cannot lose
// updates via a read-modify-write race. Writes are atomic (temp + rename) with
// tight 0o600/0o700 permissions because stashed drafts may contain sensitive
// text. A corrupt file is quarantined rather than blindly overwritten, so a
// hand-edit mistake never silently destroys saved stashes.

import { rename, rm } from "node:fs/promises";
import path from "node:path";

import {
	CommittedMutationError,
	type StashMutationResult,
	withStashFileLock,
	withStashMutationLock,
} from "./lock.ts";
import type { StashPaths } from "./paths.ts";
import {
	ensurePrivateDirectory,
	hasErrorCode,
	type PrivateTextFile,
	quarantinePrivateFile,
	readPrivateTextFile,
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

const ACTIVE_CLEANUP_MESSAGE = "active stash id queued for cleanup";
const DUPLICATE_STASH_ID_MESSAGE = "duplicate stash id";
const INVALID_ASSET_COUNT_MESSAGE = "invalid asset count";
const INVALID_CREATED_AT_MESSAGE = "invalid stash creation time";
const PENDING_STASH_ID_MESSAGE = "stash id pending asset cleanup";
const UNSUPPORTED_SCHEMA_GUIDANCE =
	"Upgrade pi-stash before using this stash, or export the stash file for safe recovery.";

export type AddEntryInput = {
	text: string;
	label?: string;
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
	phase: "directory-sync";
	error: unknown;
};

export type StashWriter = (filePath: string, file: StashFile) => Promise<void | StashWriteOutcome>;

export type RestoredAssetCleanup = {
	retained: string[];
};

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
		await withStashFileLock(this.stashFile, () => this.reloadFresh());
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
			if (input.label !== undefined && input.label.trim().length > 0) {
				entry.label = input.label.trim();
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
			if (queued.length === 0) return { didPersist: false, result: { retained } };
			const nextFile = {
				...this.file,
				updatedAt: this.now(),
				restoredAssetLeases: retained,
				pendingAssetCleanup: mergeCleanupIds(this.file.pendingAssetCleanup, queued),
			};
			return this.persistMutation(nextFile, { retained });
		});
	}

	async completeAssetCleanup(id: string): Promise<void> {
		assertSafeEntryId(id);
		await withStashMutationLock(this.stashFile, async () => {
			await this.reloadFresh();
			if (!this.file.pendingAssetCleanup.includes(id)) {
				return { didPersist: false, result: undefined };
			}
			const nextFile = {
				...this.file,
				updatedAt: this.now(),
				pendingAssetCleanup: this.file.pendingAssetCleanup.filter((cleanupId) => cleanupId !== id),
			};
			return this.persistMutation(nextFile, undefined);
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
			if (!resolved || (beforeRemove && !(await beforeRemove(resolved)))) {
				return { didPersist: false, result: undefined };
			}
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

	private async persistMutation<Result>(
		nextFile: StashFile,
		result: Result,
	): Promise<StashMutationResult<Result>> {
		const outcome = await this.write(this.stashFile, nextFile);
		this.file = nextFile;
		if (outcome?.committed) {
			throw new CommittedMutationError(result, [{ phase: outcome.phase, error: outcome.error }]);
		}
		return { didPersist: true, result };
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
	const loaded = await withStashFileLock(paths.stashFile, () =>
		readCurrentStashFile(paths.stashFile, paths.sanitized, now, write),
	);
	if (loaded.kind === "unsupported") {
		throw new UnsupportedStashSchemaError(loaded.schemaVersion);
	}
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
	// The upgrade already committed when only the directory sync fails: reporting
	// it as an error would falsely disable pi-stash over readable data. Preserve
	// the durability signal as a one-shot warning instead of failing the load.
	const outcome = await write(filePath, loaded.file);
	if (outcome?.committed) {
		const durabilityWarning =
			outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
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
	} catch (error) {
		return { committed: true, phase: "directory-sync", error };
	}
}

export { STASH_SCHEMA_VERSION };
