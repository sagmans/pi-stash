// Legacy migration keeps scope identity explicit and source selection stable.
// A private marker pins interrupted work so retries never choose a different
// source after destination state has begun to change.

import { constants } from "node:fs";
import { link, lstat, open, readdir, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { withStashFileLock } from "./lock.ts";
import {
	cwdFromReversibleSanitizedKey,
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
const DESTINATION_CONFLICT_MESSAGE = "destination conflicts with legacy stash migration";
const DESTINATION_CONFLICT_GUIDANCE =
	'Keep the file holding the drafts you want and remove the other and its matching "-assets" directory; then restart pi or run /reload';
const MALFORMED_LEGACY_MESSAGE = "malformed legacy stash cannot be migrated";
const MALFORMED_MARKER_MESSAGE = "malformed legacy migration marker";
const MISSING_ASSETS_MESSAGE = "missing owned assets for active stash entry";
const INTERRUPTED_MESSAGE = "simulated migration interruption";
const V1_AUTHORITY_REQUIRED_MESSAGE =
	"legacy v1 scope requires an authoritative current working directory";
const IRREVERSIBLE_SCOPE_MESSAGE =
	"scope key is not reversibly decodable; run migration from that working directory";
const MULTIPLE_SOURCES_MESSAGE = "multiple legacy sources exist for one stash scope";
const MARKER_PINNED_SOURCE_MESSAGE = "another legacy source is pinned by the migration marker";
const NO_LEGACY_STATE_MESSAGE = "scope has no legacy state";
const NO_FOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;

export type MigrationConflictPhase = "preflight" | "assets" | "destination";
export type DestinationAuthority = "pre-existing" | "migration";

export class MigrationConflictError extends Error {
	readonly name = "MigrationConflictError";
	readonly phase: MigrationConflictPhase;
	readonly sourceStashFile: string;
	readonly destinationStashFile: string;
	readonly destinationAuthority: DestinationAuthority;

	constructor(
		message: string,
		phase: MigrationConflictPhase,
		sourceStashFile: string,
		destinationStashFile: string,
		destinationAuthority: DestinationAuthority,
	) {
		super(message);
		this.phase = phase;
		this.sourceStashFile = sourceStashFile;
		this.destinationStashFile = destinationStashFile;
		this.destinationAuthority = destinationAuthority;
	}
}

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

export type MigrationSweepOptions = MigrationOptions & {
	authoritativeCwd?: string;
	signal?: AbortSignal;
};

export type LegacyMigrationSummary = {
	migrated: number;
	skipped: Array<{ file: string; reason: string }>;
};

type MigrationPlan = {
	source: StashPaths;
	destination: StashPaths;
};

type MigrationDiscovery = {
	plans: MigrationPlan[];
	skipped: LegacyMigrationSummary["skipped"];
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
	const plan = await planMigrationForCwd(cwd, destinationBaseDir, legacyBaseDir);
	if (!plan) return false;
	return migratePlan(plan, options);
}

// A sweep only accepts reversible v2 keys or the one v1 key backed by Pi's
// current cwd. Unsafe inference is reported for manual, in-directory recovery.
export async function migrateAllLegacyStashes(
	destinationBaseDir: string,
	legacyBaseDir: string = legacyStashBaseDir(),
	options: MigrationSweepOptions = {},
): Promise<LegacyMigrationSummary> {
	const discovery = await discoverMigrationPlans(
		destinationBaseDir,
		legacyBaseDir,
		options.authoritativeCwd,
	);
	const summary: LegacyMigrationSummary = {
		migrated: 0,
		skipped: [...discovery.skipped],
	};
	for (const plan of discovery.plans) {
		if (options.signal?.aborted) break;
		try {
			const didMigrate = await migratePlan(plan, options);
			if (didMigrate) summary.migrated += 1;
			else summary.skipped.push({ file: plan.source.stashFile, reason: NO_LEGACY_STATE_MESSAGE });
		} catch (error) {
			summary.skipped.push({
				file: plan.source.stashFile,
				reason: describeError(error),
			});
		}
	}
	return summary;
}

// Startup only needs actionable conflicts. It shares discovery with execution
// so the hinted source is the exact source a later sweep will lock and use.
export async function findLegacyMigrationConflicts(
	destinationBaseDir: string,
	legacyBaseDir: string = legacyStashBaseDir(),
	authoritativeCwd?: string,
): Promise<string[]> {
	const { plans } = await discoverMigrationPlans(
		destinationBaseDir,
		legacyBaseDir,
		authoritativeCwd,
	);
	const conflicts: string[] = [];
	for (const plan of plans) {
		if (
			(await pathExists(plan.destination.stashFile)) ||
			(await pathExists(plan.destination.assetsRoot))
		) {
			conflicts.push(plan.source.stashFile);
		}
	}
	return conflicts;
}

async function planMigrationForCwd(
	cwd: string,
	destinationBaseDir: string,
	legacyBaseDir: string,
): Promise<MigrationPlan | undefined> {
	const destination = resolveStashPaths(cwd, destinationBaseDir);
	const markerPath = markerPathFor(destination);
	if (await pathExists(markerPath)) {
		const marker = await readMarker(markerPath, destination);
		return {
			source: sourceFromMarker(cwd, marker, destinationBaseDir, legacyBaseDir),
			destination,
		};
	}

	const candidates = migrationSourcesForCwd(cwd, destinationBaseDir, legacyBaseDir);
	const existing: StashPaths[] = [];
	for (const candidate of candidates) {
		if (await pathExists(candidate.stashFile)) existing.push(candidate);
	}
	if (existing.length === 0) return undefined;
	if (existing.length > 1) {
		throw new Error(
			`${MULTIPLE_SOURCES_MESSAGE}: ${existing.map(({ stashFile }) => stashFile).join(", ")}`,
		);
	}
	return { source: existing[0] as StashPaths, destination };
}

async function discoverMigrationPlans(
	destinationBaseDir: string,
	legacyBaseDir: string,
	authoritativeCwd?: string,
): Promise<MigrationDiscovery> {
	const skipped: LegacyMigrationSummary["skipped"] = [];
	const markerPins = await discoverMarkerPins(
		destinationBaseDir,
		legacyBaseDir,
		authoritativeCwd,
		skipped,
	);
	const candidates = await discoverSourceCandidates(
		destinationBaseDir,
		legacyBaseDir,
		authoritativeCwd,
		skipped,
	);
	const grouped = new Map<string, MigrationPlan[]>();
	for (const candidate of candidates) {
		const destinationFile = candidate.destination.stashFile;
		const group = grouped.get(destinationFile) ?? [];
		group.push(candidate);
		grouped.set(destinationFile, group);
	}

	const plans: MigrationPlan[] = [];
	const destinationFiles = new Set([...grouped.keys(), ...markerPins.keys()]);
	for (const destinationFile of [...destinationFiles].sort()) {
		const pin = markerPins.get(destinationFile);
		const group = grouped.get(destinationFile) ?? [];
		if (pin) {
			plans.push(pin);
			for (const candidate of group) {
				if (candidate.source.stashFile !== pin.source.stashFile) {
					skipped.push({ file: candidate.source.stashFile, reason: MARKER_PINNED_SOURCE_MESSAGE });
				}
			}
			continue;
		}
		if (group.length === 1) {
			plans.push(group[0] as MigrationPlan);
			continue;
		}
		for (const candidate of group) {
			skipped.push({ file: candidate.source.stashFile, reason: MULTIPLE_SOURCES_MESSAGE });
		}
	}
	return { plans, skipped };
}

async function discoverMarkerPins(
	destinationBaseDir: string,
	legacyBaseDir: string,
	authoritativeCwd: string | undefined,
	skipped: LegacyMigrationSummary["skipped"],
): Promise<Map<string, MigrationPlan>> {
	const pins = new Map<string, MigrationPlan>();
	for (const markerPath of await listMigrationMarkerFiles(destinationBaseDir)) {
		try {
			const destinationKeyWithExtension = path.basename(markerPath, MIGRATION_SUFFIX);
			const destinationKey = path.basename(destinationKeyWithExtension, ".json");
			const authoritativeDestination = authoritativeCwd
				? resolveStashPaths(authoritativeCwd, destinationBaseDir)
				: undefined;
			const cwd =
				authoritativeDestination && markerPathFor(authoritativeDestination) === markerPath
					? authoritativeCwd
					: cwdFromReversibleSanitizedKey(destinationKey);
			if (!cwd) throw new Error(`${MALFORMED_MARKER_MESSAGE}: ${IRREVERSIBLE_SCOPE_MESSAGE}`);
			const destination = resolveStashPaths(cwd, destinationBaseDir);
			if (markerPathFor(destination) !== markerPath) {
				throw new Error(`${MALFORMED_MARKER_MESSAGE}: scope mismatch`);
			}
			const marker = await readMarker(markerPath, destination);
			pins.set(destination.stashFile, {
				source: sourceFromMarker(cwd, marker, destinationBaseDir, legacyBaseDir),
				destination,
			});
		} catch (error) {
			skipped.push({ file: markerPath, reason: describeError(error) });
		}
	}
	return pins;
}

async function discoverSourceCandidates(
	destinationBaseDir: string,
	legacyBaseDir: string,
	authoritativeCwd: string | undefined,
	skipped: LegacyMigrationSummary["skipped"],
): Promise<MigrationPlan[]> {
	const candidates: MigrationPlan[] = [];
	const sameRoot = path.resolve(legacyBaseDir) === path.resolve(destinationBaseDir);
	for (const filePath of await listLegacyScopeFiles(legacyBaseDir)) {
		const key = path.basename(filePath, ".json");
		const form = isSanitizedKey(key);
		if (!form || (sameRoot && form === "v2")) continue;
		try {
			const cwd = await cwdForSourceFile(filePath, key, form, authoritativeCwd);
			const source =
				form === "v1"
					? resolveLegacyStashPaths(cwd, legacyBaseDir)
					: resolveStashPaths(cwd, legacyBaseDir);
			if (source.stashFile !== filePath) throw new Error(MALFORMED_LEGACY_MESSAGE);
			candidates.push({
				source,
				destination: resolveStashPaths(cwd, destinationBaseDir),
			});
		} catch (error) {
			skipped.push({ file: filePath, reason: describeError(error) });
		}
	}
	return candidates;
}

async function cwdForSourceFile(
	filePath: string,
	key: string,
	form: "v1" | "v2",
	authoritativeCwd?: string,
): Promise<string> {
	const text = await readPrivateTextFile(filePath, "legacy stash file");
	let raw: unknown;
	try {
		raw = JSON.parse(text.text);
	} catch {
		throw new Error(MALFORMED_LEGACY_MESSAGE);
	}
	if (!isRecord(raw) || raw.cwd !== key) throw new Error(MALFORMED_LEGACY_MESSAGE);
	if (form === "v1") {
		if (!authoritativeCwd) throw new Error(V1_AUTHORITY_REQUIRED_MESSAGE);
		if (resolveLegacyStashPaths(authoritativeCwd, path.dirname(filePath)).stashFile !== filePath) {
			throw new Error(V1_AUTHORITY_REQUIRED_MESSAGE);
		}
		return authoritativeCwd;
	}
	if (
		authoritativeCwd &&
		resolveStashPaths(authoritativeCwd, path.dirname(filePath)).stashFile === filePath
	) {
		return authoritativeCwd;
	}
	const cwd = cwdFromReversibleSanitizedKey(key);
	if (!cwd) throw new Error(IRREVERSIBLE_SCOPE_MESSAGE);
	return cwd;
}

async function listLegacyScopeFiles(legacyBaseDir: string): Promise<string[]> {
	return (await listDirectoryNames(legacyBaseDir))
		.filter((name) => name.endsWith(".json") && !name.endsWith(MIGRATION_SUFFIX))
		.map((name) => path.join(legacyBaseDir, name));
}

async function listMigrationMarkerFiles(destinationBaseDir: string): Promise<string[]> {
	return (await listDirectoryNames(destinationBaseDir))
		.filter((name) => name.endsWith(MIGRATION_SUFFIX))
		.map((name) => path.join(destinationBaseDir, name));
}

async function listDirectoryNames(directory: string): Promise<string[]> {
	try {
		return (await readdir(directory)).sort();
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return [];
		throw error;
	}
}

function migrationSourcesForCwd(
	cwd: string,
	destinationBaseDir: string,
	legacyBaseDir: string,
): StashPaths[] {
	const candidates: StashPaths[] = [];
	if (path.resolve(legacyBaseDir) !== path.resolve(destinationBaseDir)) {
		candidates.push(resolveStashPaths(cwd, legacyBaseDir));
	}
	candidates.push(resolveLegacyStashPaths(cwd, legacyBaseDir));
	return candidates;
}

function sourceFromMarker(
	cwd: string,
	marker: MigrationMarker,
	destinationBaseDir: string,
	legacyBaseDir: string,
): StashPaths {
	const candidates = migrationSourcesForCwd(cwd, destinationBaseDir, legacyBaseDir);
	const source = candidates.find(({ stashFile }) => stashFile === marker.sourceStashFile);
	if (!source) throw new Error(`${MALFORMED_MARKER_MESSAGE}: source scope mismatch`);
	return source;
}

async function migratePlan(plan: MigrationPlan, options: MigrationOptions): Promise<boolean> {
	return withStashFileLock(plan.source.stashFile, () =>
		withStashFileLock(plan.destination.stashFile, () =>
			migrateLocked(plan.source, plan.destination, options),
		),
	);
}

async function migrateLocked(
	source: StashPaths,
	destination: StashPaths,
	options: MigrationOptions,
): Promise<boolean> {
	const markerPath = markerPathFor(destination);
	const markerExists = await pathExists(markerPath);
	let marker: MigrationMarker;
	let sourceFile: StashFile | undefined;

	if (markerExists) {
		marker = await readMarker(markerPath, destination);
		if (marker.sourceStashFile !== source.stashFile) {
			throw new Error(`${MALFORMED_MARKER_MESSAGE}: source scope mismatch`);
		}
		sourceFile = await readLegacyFileIfPresent(source);
		if (sourceFile) assertMarkerMatchesFile(marker, sourceFile);
	} else {
		sourceFile = await readLegacyFileIfPresent(source);
		if (!sourceFile) return false;
		if ((await pathExists(destination.stashFile)) || (await pathExists(destination.assetsRoot))) {
			throw migrationConflict(
				"preflight",
				source,
				destination,
				`${source.stashFile} and ${destination.stashFile} both exist for this directory`,
				"pre-existing",
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
		try {
			await installPrivateTextFile(
				destination.stashFile,
				`${JSON.stringify(sourceFile, null, 2)}\n`,
			);
		} catch (error) {
			if (!hasErrorCode(error, "EEXIST")) throw error;
		}
	}
	const committed = await readMigratedFile(source, destination);
	if (sourceFile && !sameFile(committed, sourceFile)) {
		throw migrationConflict(
			"destination",
			source,
			destination,
			`${destination.stashFile} changed during migration and no longer matches ${source.stashFile}`,
			"migration",
		);
	}
	interruptAfter("destination", options);

	await removeMigratedSource(source, marker, options.syncSourceParent ?? syncPrivateDirectory);
	await unlink(markerPath);
	await syncPrivateDirectory(path.dirname(markerPath));
	return true;
}

function markerPathFor(destination: StashPaths): string {
	return `${destination.stashFile}${MIGRATION_SUFFIX}`;
}

function migrationConflict(
	phase: MigrationConflictPhase,
	source: StashPaths,
	destination: StashPaths,
	detail: string,
	destinationAuthority: DestinationAuthority,
): MigrationConflictError {
	return new MigrationConflictError(
		`${DESTINATION_CONFLICT_MESSAGE}: ${detail}. ${DESTINATION_CONFLICT_GUIDANCE}`,
		phase,
		source.stashFile,
		destination.stashFile,
		destinationAuthority,
	);
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

// v1 state must be re-keyed because the destination loader verifies that file
// identity and location agree before exposing drafts.
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
			await copyAssetDirectory(source, destination, sourceDirectory, destinationDirectory);
		}
		if (marker.requiredAssetIds.includes(id) && !(await pathExists(destinationDirectory))) {
			throw new Error(`${MISSING_ASSETS_MESSAGE} ${id}`);
		}
	}
}

async function copyAssetDirectory(
	source: StashPaths,
	destination: StashPaths,
	sourceDirectory: string,
	destinationDirectory: string,
): Promise<void> {
	await assertPrivateDirectory(sourceDirectory, "legacy asset directory");
	await ensurePrivateDirectory(path.dirname(destinationDirectory));
	await ensurePrivateDirectory(destinationDirectory);
	const entries = await readdir(sourceDirectory, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile() || entry.isSymbolicLink()) {
			throw new Error("legacy asset directory contains a non-regular file");
		}
		const sourceFile = path.join(sourceDirectory, entry.name);
		const destinationFile = path.join(destinationDirectory, entry.name);
		const bytes = await readPrivateBytes(sourceFile, "legacy asset file");
		if (await pathExists(destinationFile)) {
			const existing = await readPrivateBytes(destinationFile, "migrated asset file");
			if (!existing.equals(bytes)) {
				throw migrationConflict(
					"assets",
					source,
					destination,
					`${destinationFile} differs from legacy ${sourceFile}`,
					"migration",
				);
			}
		} else {
			await writePrivateBytes(destinationFile, bytes);
		}
	}
	await syncPrivateDirectory(destinationDirectory, "migrated asset directory");
	await syncPrivateDirectory(path.dirname(destinationDirectory));
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

async function readMigratedFile(source: StashPaths, destination: StashPaths): Promise<StashFile> {
	const text = (await readPrivateTextFile(destination.stashFile, "migrated stash file")).text;
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw migrationConflict(
			"destination",
			source,
			destination,
			`${destination.stashFile} is not a valid stash file for this scope`,
			"migration",
		);
	}
	const parsed = parseStashFile(raw);
	if (!parsed || parsed.file.cwd !== destination.sanitized) {
		throw migrationConflict(
			"destination",
			source,
			destination,
			`${destination.stashFile} is not a valid stash file for this scope`,
			"migration",
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

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
