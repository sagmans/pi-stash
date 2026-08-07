// One-scope migration from pi-stash's historical fixed home root to Pi's
// configured agent root, covering both historical key formats (the current
// v2-prefixed key and the vendored predecessor's unprefixed v1 key). A
// private marker makes interrupted copies resumable; source data is removed
// only after normalized state and every owned asset are verified at the
// destination.

import { constants } from "node:fs";
import { link, lstat, open, readdir, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { withStashFileLock } from "./lock.ts";
import {
	cwdFromSanitizedKey,
	isSanitizedKey,
	resolveLegacyStashPaths,
	resolveStashPaths,
	type StashPaths,
} from "./paths.ts";
import {
	assertPrivateDirectory,
	assertRegularOwnedFile,
	ensurePrivateDirectory,
	hasErrorCode,
	PRIVATE_FILE_MODE,
	type PrivateTextFile,
	pathExists,
	quarantinePrivateDirectory,
	quarantinePrivateFile,
	readPrivateTextFile,
	removePrivateDirectory,
	syncPrivateDirectory,
	writePrivateFileExclusive,
} from "./private-fs.ts";
import { isRecord, isSafeEntryId, parseStashFile, type StashFile } from "./types.ts";

const LEGACY_AGENT_SUBDIRECTORY = ".pi/agent/pi-stash";
const MIGRATION_MARKER_VERSION = 1;
const MIGRATION_SUFFIX = ".migration.json";
const MIGRATION_TEMP_SUFFIX = ".migration-tmp";
const MIGRATED_QUARANTINE_LABEL = "migrated";
const MIGRATE_CONFLICT_LABEL = "migrate-conflict";
const DESTINATION_CONFLICT_MESSAGE = "destination conflicts with legacy stash migration";
const DESTINATION_CONFLICT_GUIDANCE =
	'Review both files, keep the one holding the drafts you want, remove the other and its matching "-assets" directory, then run /reload';
const MALFORMED_LEGACY_MESSAGE = "malformed legacy stash cannot be migrated";
const MALFORMED_MARKER_MESSAGE = "malformed legacy migration marker";
const MISSING_ASSETS_MESSAGE = "missing owned assets for active stash entry";
const INTERRUPTED_MESSAGE = "simulated migration interruption";
const NO_FOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;

type MigrationMarker = {
	version: typeof MIGRATION_MARKER_VERSION;
	cwdKey: string;
	sourceStashFile: string;
	destinationStashFile: string;
	assetIds: string[];
	requiredAssetIds: string[];
};

type MigrationOptions = {
	failAfter?: "marker" | "assets" | "destination";
	syncSourceParent?: (directory: string) => Promise<void>;
};

export function legacyStashBaseDir(homeDirectory: string = homedir()): string {
	return path.join(homeDirectory, LEGACY_AGENT_SUBDIRECTORY);
}

export async function migrateLegacyStash(
	cwd: string,
	destinationBaseDir: string,
	legacyBaseDir: string = legacyStashBaseDir(),
	options: MigrationOptions = {},
): Promise<boolean> {
	const destination = resolveStashPaths(cwd, destinationBaseDir);
	const markerPath = `${destination.stashFile}${MIGRATION_SUFFIX}`;
	const source = await resolveMigrationSource(
		cwd,
		legacyBaseDir,
		destinationBaseDir,
		destination,
		markerPath,
	);
	if (!source) return false;
	return withStashFileLock(source.stashFile, () =>
		withStashFileLock(destination.stashFile, () => migrateLocked(source, destination, options)),
	);
}

export type LegacyMigrationSummary = {
	migrated: number;
	quarantined: number;
	skipped: Array<{ file: string; reason: string }>;
};

// Sweep every legacy scope under the legacy root so one command unblocks all
// directories, not just the current cwd. Conflicts quarantine the superseded
// legacy state instead of failing, because choosing a winner for the user
// could destroy drafts; the quarantine keeps the legacy bytes recoverable.
export async function migrateAllLegacyStashes(
	destinationBaseDir: string,
	legacyBaseDir: string = legacyStashBaseDir(),
): Promise<LegacyMigrationSummary> {
	const summary: LegacyMigrationSummary = { migrated: 0, quarantined: 0, skipped: [] };
	const sameRoot = path.resolve(legacyBaseDir) === path.resolve(destinationBaseDir);
	const scopes = await listLegacyScopeFiles(legacyBaseDir);
	for (const filePath of scopes) {
		const form = isSanitizedKey(path.basename(filePath, ".json"));
		// Current-format files in a same-root sweep are destinations, not legacy.
		if (!form || (sameRoot && form !== "v1")) continue;
		const cwd = await scopeCwdForFile(filePath, sameRoot);
		if (!cwd) {
			summary.skipped.push({ file: filePath, reason: MALFORMED_LEGACY_MESSAGE });
			continue;
		}
		try {
			const didMigrate = await migrateLegacyStash(cwd, destinationBaseDir, legacyBaseDir);
			if (didMigrate) summary.migrated += 1;
			else summary.skipped.push({ file: filePath, reason: "scope has no legacy state" });
		} catch (error) {
			if (isDestinationConflict(error)) {
				await quarantineLegacyConflict(cwd, legacyBaseDir, sameRoot);
				summary.quarantined += 1;
			} else {
				summary.skipped.push({
					file: filePath,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
	return summary;
}

// Startup check that only reports, never migrates: any legacy scope whose
// destination already exists needs the user's decision, so surface a hint to
// run the sweep command instead of silently failing one directory at a time.
export async function findLegacyMigrationConflicts(
	destinationBaseDir: string,
	legacyBaseDir: string = legacyStashBaseDir(),
): Promise<string[]> {
	const sameRoot = path.resolve(legacyBaseDir) === path.resolve(destinationBaseDir);
	const conflicts: string[] = [];
	for (const filePath of await listLegacyScopeFiles(legacyBaseDir)) {
		const form = isSanitizedKey(path.basename(filePath, ".json"));
		// Current-format files in a same-root sweep are destinations, not legacy.
		if (!form || (sameRoot && form !== "v1")) continue;
		const cwd = await scopeCwdForFile(filePath, sameRoot);
		if (!cwd) continue;
		const destination = resolveStashPaths(cwd, destinationBaseDir);
		if ((await pathExists(destination.stashFile)) || (await pathExists(destination.assetsRoot))) {
			conflicts.push(filePath);
		}
	}
	return conflicts;
}

async function listLegacyScopeFiles(legacyBaseDir: string): Promise<string[]> {
	let files: string[];
	try {
		files = await readdir(legacyBaseDir);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return [];
		throw error;
	}
	return files
		.filter((name) => name.endsWith(".json") && !name.endsWith(MIGRATION_SUFFIX))
		.sort()
		.map((name) => path.join(legacyBaseDir, name));
}

// The stash file records the flattened key as its cwd, so the scope is
// recovered by inverting the sanitizer. The filename must still match the key
// derived from that cwd, or the file is not a legacy scope we may move.
async function scopeCwdForFile(filePath: string, sameRoot: boolean): Promise<string | undefined> {
	let text: PrivateTextFile;
	try {
		text = await readPrivateTextFile(filePath, "legacy stash file");
	} catch {
		return undefined;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text.text);
	} catch {
		return undefined;
	}
	if (!isRecord(raw) || typeof raw.cwd !== "string") return undefined;
	const form = isSanitizedKey(raw.cwd);
	if (!form || (sameRoot && form !== "v1") || raw.cwd !== path.basename(filePath, ".json")) {
		return undefined;
	}
	const cwd = cwdFromSanitizedKey(raw.cwd);
	if (!cwd) return undefined;
	if (
		form === "v1" &&
		resolveLegacyStashPaths(cwd, path.dirname(filePath)).stashFile === filePath
	) {
		return cwd;
	}
	if (form === "v2" && resolveStashPaths(cwd, path.dirname(filePath)).stashFile === filePath) {
		return cwd;
	}
	return undefined;
}

function isDestinationConflict(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith(DESTINATION_CONFLICT_MESSAGE);
}

// Superseded legacy state is preserved under a quarantine label instead of
// deleted; the v2 destination stays authoritative for the scope. The source
// candidate follows resolveMigrationSource: same-root upgrades can only have
// v1-keyed sources, while a distinct legacy root may hold v2-keyed ones.
async function quarantineLegacyConflict(
	cwd: string,
	legacyBaseDir: string,
	sameRoot: boolean,
): Promise<void> {
	const candidates = sameRoot
		? [resolveLegacyStashPaths(cwd, legacyBaseDir)]
		: [resolveStashPaths(cwd, legacyBaseDir), resolveLegacyStashPaths(cwd, legacyBaseDir)];
	let source: StashPaths | undefined;
	for (const candidate of candidates) {
		if (await pathExists(candidate.stashFile)) {
			source = candidate;
			break;
		}
	}
	if (!source) return;
	const legacy = await readPrivateTextFile(source.stashFile, "legacy stash file");
	await quarantinePrivateFile(source.stashFile, legacy.identity, MIGRATE_CONFLICT_LABEL);
	await quarantinePrivateDirectory(source.assetsRoot, MIGRATE_CONFLICT_LABEL);
}

// Two historical key formats can outlive an upgrade: the current v2-prefixed
// key and the vendored predecessor's unprefixed v1 key. A same-root upgrade
// only ever sources the v1 key, because the v2 key resolves to the
// destination file itself.
async function resolveMigrationSource(
	cwd: string,
	legacyBaseDir: string,
	destinationBaseDir: string,
	destination: StashPaths,
	markerPath: string,
): Promise<StashPaths | undefined> {
	const candidates: StashPaths[] = [];
	if (path.resolve(legacyBaseDir) !== path.resolve(destinationBaseDir)) {
		candidates.push(resolveStashPaths(cwd, legacyBaseDir));
	}
	candidates.push(resolveLegacyStashPaths(cwd, legacyBaseDir));
	if (!(await pathExists(markerPath))) {
		for (const candidate of candidates) {
			if (await pathExists(candidate.stashFile)) return candidate;
		}
		return undefined;
	}
	// An interrupted migration must resume from the exact source the marker
	// recorded, or that scope's asset bookkeeping would be abandoned.
	const marker = await readMarker(markerPath, destination);
	const pinned = candidates.find((candidate) => candidate.stashFile === marker.sourceStashFile);
	if (!pinned) throw new Error(`${MALFORMED_MARKER_MESSAGE}: scope mismatch`);
	return pinned;
}

async function migrateLocked(
	source: StashPaths,
	destination: StashPaths,
	options: MigrationOptions,
): Promise<boolean> {
	const markerPath = `${destination.stashFile}${MIGRATION_SUFFIX}`;
	const markerExists = await pathExists(markerPath);
	let marker: MigrationMarker;
	let sourceFile: StashFile | undefined;

	if (markerExists) {
		marker = await readMarker(markerPath, destination);
		sourceFile = await readLegacyFileIfPresent(source);
		if (sourceFile) assertMarkerMatchesFile(marker, sourceFile);
	} else {
		sourceFile = await readLegacyFileIfPresent(source);
		if (!sourceFile) return false;
		if ((await pathExists(destination.stashFile)) || (await pathExists(destination.assetsRoot))) {
			throw new Error(
				`${DESTINATION_CONFLICT_MESSAGE}: ${source.stashFile} and ${destination.stashFile} both exist for this directory. ${DESTINATION_CONFLICT_GUIDANCE}`,
			);
		}
		marker = markerFor(source, destination, sourceFile);
		await verifyRequiredSourceAssets(source, marker.requiredAssetIds);
		await ensurePrivateDirectory(path.dirname(markerPath));
		await installPrivateTextFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
	}
	if (sourceFile) sourceFile = rekeyedForDestination(sourceFile, destination);

	interruptAfter("marker", options);
	await copyOwnedAssets(source, destination, marker);
	interruptAfter("assets", options);

	if (!(await pathExists(destination.stashFile))) {
		if (!sourceFile) throw new Error(`${MALFORMED_LEGACY_MESSAGE}: source disappeared`);
		await installPrivateTextFile(destination.stashFile, `${JSON.stringify(sourceFile, null, 2)}\n`);
	}
	const committed = await readMigratedFile(destination.stashFile, destination.sanitized);
	if (sourceFile && !sameFile(committed, sourceFile)) {
		throw new Error(
			`${DESTINATION_CONFLICT_MESSAGE}: ${destination.stashFile} changed during migration and no longer matches ${source.stashFile}. ${DESTINATION_CONFLICT_GUIDANCE}`,
		);
	}
	interruptAfter("destination", options);

	await removeMigratedSource(source, marker, options.syncSourceParent ?? syncPrivateDirectory);
	await unlink(markerPath);
	await syncPrivateDirectory(path.dirname(markerPath));
	return true;
}

function markerFor(source: StashPaths, destination: StashPaths, file: StashFile): MigrationMarker {
	const { assetIds, requiredAssetIds } = assetOwnership(file);
	return {
		version: MIGRATION_MARKER_VERSION,
		cwdKey: destination.sanitized,
		sourceStashFile: source.stashFile,
		destinationStashFile: destination.stashFile,
		assetIds,
		requiredAssetIds,
	};
}

function assetOwnership(file: StashFile): Pick<MigrationMarker, "assetIds" | "requiredAssetIds"> {
	const activeIds = file.entries.map((entry) => entry.id);
	const requiredActiveIds = file.entries
		.filter((entry) => (entry.assetCount ?? 0) > 0)
		.map((entry) => entry.id);
	return {
		assetIds: [
			...new Set([...activeIds, ...file.restoredAssetLeases, ...file.pendingAssetCleanup]),
		],
		requiredAssetIds: [...new Set([...requiredActiveIds, ...file.restoredAssetLeases])],
	};
}

async function readMarker(markerPath: string, destination: StashPaths): Promise<MigrationMarker> {
	const text = (await readPrivateTextFile(markerPath, "legacy migration marker")).text;
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error(MALFORMED_MARKER_MESSAGE);
	}
	if (!isMigrationMarker(raw)) throw new Error(MALFORMED_MARKER_MESSAGE);
	if (raw.cwdKey !== destination.sanitized || raw.destinationStashFile !== destination.stashFile) {
		throw new Error(`${MALFORMED_MARKER_MESSAGE}: scope mismatch`);
	}
	return raw;
}

// v1-keyed files embed the flattened cwd in the file itself; the destination
// must record its own key so later loads can verify file-location coherence.
function rekeyedForDestination(file: StashFile, destination: StashPaths): StashFile {
	if (file.cwd === destination.sanitized) return file;
	return { ...file, cwd: destination.sanitized };
}

function isMigrationMarker(value: unknown): value is MigrationMarker {
	if (!isRecord(value)) return false;
	const { assetIds, requiredAssetIds } = value;
	return (
		value.version === MIGRATION_MARKER_VERSION &&
		typeof value.cwdKey === "string" &&
		typeof value.sourceStashFile === "string" &&
		typeof value.destinationStashFile === "string" &&
		isIdArray(assetIds) &&
		isIdArray(requiredAssetIds) &&
		requiredAssetIds.every((id) => assetIds.includes(id))
	);
}

function isIdArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.every((id) => typeof id === "string" && isSafeEntryId(id)) &&
		new Set(value).size === value.length
	);
}

async function readLegacyFileIfPresent(paths: StashPaths): Promise<StashFile | undefined> {
	let source: PrivateTextFile;
	try {
		source = await readPrivateTextFile(paths.stashFile, "legacy stash file");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(source.text);
	} catch {
		throw new Error(MALFORMED_LEGACY_MESSAGE);
	}
	const parsed = parseStashFile(raw);
	if (!parsed || parsed.file.cwd !== paths.sanitized) throw new Error(MALFORMED_LEGACY_MESSAGE);
	return parsed.file;
}

function assertMarkerMatchesFile(marker: MigrationMarker, file: StashFile): void {
	const expected = assetOwnership(file);
	if (
		!sameIds(marker.assetIds, expected.assetIds) ||
		!sameIds(marker.requiredAssetIds, expected.requiredAssetIds)
	) {
		throw new Error(`${MALFORMED_MARKER_MESSAGE}: legacy state changed`);
	}
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((id, index) => id === right[index]);
}

async function verifyRequiredSourceAssets(
	source: StashPaths,
	ids: readonly string[],
): Promise<void> {
	for (const id of ids) {
		try {
			await assertPrivateDirectory(source.assetDir(id), "legacy asset directory");
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) throw new Error(`${MISSING_ASSETS_MESSAGE} ${id}`);
			throw error;
		}
	}
}

async function copyOwnedAssets(
	source: StashPaths,
	destination: StashPaths,
	marker: MigrationMarker,
): Promise<void> {
	for (const id of marker.assetIds) {
		const sourceDirectory = source.assetDir(id);
		const destinationDirectory = destination.assetDir(id);
		if (await pathExists(sourceDirectory)) {
			await copyAssetDirectory(sourceDirectory, destinationDirectory);
		}
		if (marker.requiredAssetIds.includes(id) && !(await pathExists(destinationDirectory))) {
			throw new Error(`${MISSING_ASSETS_MESSAGE} ${id}`);
		}
	}
}

async function copyAssetDirectory(source: string, destination: string): Promise<void> {
	await assertPrivateDirectory(source, "legacy asset directory");
	await ensurePrivateDirectory(path.dirname(destination));
	await ensurePrivateDirectory(destination);
	const entries = await readdir(source, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile() || entry.isSymbolicLink()) {
			throw new Error("legacy asset directory contains a non-regular file");
		}
		const sourceFile = path.join(source, entry.name);
		const destinationFile = path.join(destination, entry.name);
		const bytes = await readPrivateBytes(sourceFile, "legacy asset file");
		if (await pathExists(destinationFile)) {
			const existing = await readPrivateBytes(destinationFile, "migrated asset file");
			if (!existing.equals(bytes)) {
				throw new Error(
					`${DESTINATION_CONFLICT_MESSAGE}: ${destinationFile} differs from legacy ${sourceFile}. ${DESTINATION_CONFLICT_GUIDANCE}`,
				);
			}
		} else {
			await writePrivateBytes(destinationFile, bytes);
		}
	}
	await syncPrivateDirectory(destination, "migrated asset directory");
	await syncPrivateDirectory(path.dirname(destination));
}

async function readPrivateBytes(filePath: string, label: string): Promise<Buffer> {
	const before = await lstat(filePath);
	assertRegularOwnedFile(before, label);
	const handle = await open(filePath, constants.O_RDONLY | NO_FOLLOW_FLAG);
	try {
		const opened = await handle.stat();
		assertRegularOwnedFile(opened, label);
		if (opened.dev !== before.dev || opened.ino !== before.ino) {
			throw new Error(`${label} changed during validation`);
		}
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

async function writePrivateBytes(filePath: string, bytes: Buffer): Promise<void> {
	const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW_FLAG;
	const handle = await open(filePath, flags, PRIVATE_FILE_MODE);
	let succeeded = false;
	try {
		await handle.writeFile(bytes);
		await handle.chmod(PRIVATE_FILE_MODE);
		await handle.sync();
		succeeded = true;
	} finally {
		await handle.close();
		if (!succeeded) await unlink(filePath).catch(() => undefined);
	}
}

async function installPrivateTextFile(filePath: string, text: string): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${MIGRATION_TEMP_SUFFIX}`;
	await writePrivateFileExclusive(tempPath, text);
	try {
		await link(tempPath, filePath);
		await syncPrivateDirectory(path.dirname(filePath));
	} finally {
		await unlink(tempPath).catch(() => undefined);
	}
}

async function readMigratedFile(filePath: string, cwdKey: string): Promise<StashFile> {
	const text = (await readPrivateTextFile(filePath, "migrated stash file")).text;
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error(
			`${DESTINATION_CONFLICT_MESSAGE}: ${filePath} is not a valid stash file for this scope. ${DESTINATION_CONFLICT_GUIDANCE}`,
		);
	}
	const parsed = parseStashFile(raw);
	if (!parsed || parsed.file.cwd !== cwdKey) {
		throw new Error(
			`${DESTINATION_CONFLICT_MESSAGE}: ${filePath} is not a valid stash file for this scope. ${DESTINATION_CONFLICT_GUIDANCE}`,
		);
	}
	return parsed.file;
}

function sameFile(left: StashFile, right: StashFile): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

async function removeMigratedSource(
	source: StashPaths,
	marker: MigrationMarker,
	syncSourceParent: (directory: string) => Promise<void>,
): Promise<void> {
	for (const id of marker.assetIds) await removePrivateDirectory(source.assetDir(id));
	try {
		const legacy = await readPrivateTextFile(source.stashFile, "legacy stash file");
		const moved = await quarantinePrivateFile(
			source.stashFile,
			legacy.identity,
			MIGRATED_QUARANTINE_LABEL,
		);
		await unlink(moved);
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) throw error;
	}
	await rmdir(source.assetsRoot).catch((error: unknown) => {
		if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTEMPTY")) throw error;
	});
	await syncSourceParent(path.dirname(source.stashFile));
}

function interruptAfter(stage: MigrationOptions["failAfter"], options: MigrationOptions): void {
	if (options.failAfter === stage) throw new Error(INTERRUPTED_MESSAGE);
}
