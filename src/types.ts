// Stash entry + file schema and pure parsing/validation helpers.
//
// All disk formats are validated on read so a corrupt or hand-edited stash file
// can never crash the editor: an unparseable file is treated as empty. Keeping
// this module free of fs/SDK dependencies makes the schema fully unit-testable.

import { randomUUID } from "node:crypto";

export const STASH_SCHEMA_VERSION = 2;

const LEGACY_STASH_SCHEMA_VERSION = 1;
const ENTRY_ID_MAX_LENGTH = 128;
const ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INVALID_ENTRY_ID_MESSAGE = "invalid stash entry id";
const NUMERIC_SELECTOR_PATTERN = /^\d+$/;

export function isSafeEntryId(value: string): boolean {
	return value.length <= ENTRY_ID_MAX_LENGTH && ENTRY_ID_PATTERN.test(value);
}

export function assertSafeEntryId(value: string): void {
	if (!isSafeEntryId(value)) throw new Error(INVALID_ENTRY_ID_MESSAGE);
}

export type StashEntry = {
	id: string;
	text: string;
	createdAt: number;
	/** Optional user-supplied label from `/stash <msg>`. */
	message?: string;
	/** Count of tmp-dir images persisted into the entry's asset dir. */
	assetCount?: number;
};

export type StashFile = {
	schemaVersion: typeof STASH_SCHEMA_VERSION;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	entries: StashEntry[];
	/** Asset directory ids still referenced by text restored into an editor. */
	restoredAssetLeases: string[];
	/** Asset directory ids awaiting durable best-effort removal. */
	pendingAssetCleanup: string[];
};

export type Clock = () => number;

export function createNewId(): string {
	return randomUUID();
}

export function createEmptyStashFile(cwd: string, now: number): StashFile {
	return {
		schemaVersion: STASH_SCHEMA_VERSION,
		cwd,
		createdAt: now,
		updatedAt: now,
		entries: [],
		restoredAssetLeases: [],
		pendingAssetCleanup: [],
	};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidTimestamp(value: unknown): value is number {
	return (
		typeof value === "number" && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime())
	);
}

export function normalizeEntry(raw: unknown): StashEntry | undefined {
	if (!isRecord(raw)) return undefined;
	const { id, text, createdAt, message, assetCount } = raw;
	if (typeof id !== "string" || !isSafeEntryId(id)) return undefined;
	if (typeof text !== "string") return undefined;
	if (!isValidTimestamp(createdAt)) return undefined;
	if (message !== undefined && typeof message !== "string") return undefined;
	if (
		assetCount !== undefined &&
		(typeof assetCount !== "number" || !Number.isSafeInteger(assetCount) || assetCount < 0)
	) {
		return undefined;
	}
	const entry: StashEntry = { id, text, createdAt };
	if (message !== undefined) entry.message = message;
	if (assetCount !== undefined) entry.assetCount = assetCount;
	return entry;
}

type StashFileBody = Omit<
	StashFile,
	"schemaVersion" | "restoredAssetLeases" | "pendingAssetCleanup"
>;

export type ParsedStashFile = {
	file: StashFile;
	migratedFrom?: typeof LEGACY_STASH_SCHEMA_VERSION;
};

export function normalizeStashFile(raw: unknown): StashFile | undefined {
	if (!isRecord(raw) || raw.schemaVersion !== STASH_SCHEMA_VERSION) return undefined;
	const body = normalizeStashFileBody(raw);
	if (!body || raw.pendingAssetCleanup === undefined) return undefined;
	const activeIds = new Set(body.entries.map((entry) => entry.id));
	const restoredAssetLeases = normalizeOwnedIds(raw.restoredAssetLeases ?? [], activeIds, false);
	if (!restoredAssetLeases) return undefined;
	const unavailableIds = new Set([...activeIds, ...restoredAssetLeases]);
	const pendingAssetCleanup = normalizeOwnedIds(raw.pendingAssetCleanup, unavailableIds, false);
	if (!pendingAssetCleanup) return undefined;
	return {
		schemaVersion: STASH_SCHEMA_VERSION,
		...body,
		restoredAssetLeases,
		pendingAssetCleanup,
	};
}

export function parseStashFile(raw: unknown): ParsedStashFile | undefined {
	const current = normalizeStashFile(raw);
	if (current) return { file: current };
	if (!isRecord(raw) || raw.schemaVersion !== LEGACY_STASH_SCHEMA_VERSION) return undefined;
	const body = normalizeStashFileBody(raw);
	if (!body) return undefined;
	const activeIds = new Set(body.entries.map((entry) => entry.id));
	const pendingAssetCleanup = normalizeOwnedIds(raw.pendingAssetCleanup ?? [], activeIds, true);
	if (!pendingAssetCleanup) return undefined;
	return {
		file: {
			schemaVersion: STASH_SCHEMA_VERSION,
			...body,
			restoredAssetLeases: [],
			pendingAssetCleanup,
		},
		migratedFrom: LEGACY_STASH_SCHEMA_VERSION,
	};
}

function normalizeStashFileBody(raw: Record<string, unknown>): StashFileBody | undefined {
	if (typeof raw.cwd !== "string") return undefined;
	if (!isValidTimestamp(raw.createdAt) || !isValidTimestamp(raw.updatedAt)) return undefined;
	if (!Array.isArray(raw.entries)) return undefined;
	const entries: StashEntry[] = [];
	const entryIds = new Set<string>();
	for (const rawEntry of raw.entries) {
		const entry = normalizeEntry(rawEntry);
		if (!entry || entryIds.has(entry.id)) return undefined;
		entryIds.add(entry.id);
		entries.push(entry);
	}
	return {
		cwd: raw.cwd,
		createdAt: raw.createdAt,
		updatedAt: raw.updatedAt,
		entries,
	};
}

function normalizeOwnedIds(
	raw: unknown,
	activeIds: ReadonlySet<string>,
	discardActiveIds: boolean,
): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const cleanupIds: string[] = [];
	for (const id of raw) {
		if (typeof id !== "string" || !isSafeEntryId(id)) return undefined;
		if (activeIds.has(id)) {
			if (discardActiveIds) continue;
			return undefined;
		}
		if (!cleanupIds.includes(id)) cleanupIds.push(id);
	}
	return cleanupIds;
}

export type ResolvedEntry = { entry: StashEntry; index: number };

// git-style indexing: index 0 is the newest. A selector may be an entry id, a
// numeric index string, or empty (defaults to the most recent entry).
export function resolveBySelector(
	entries: readonly StashEntry[],
	selector: string | undefined,
): ResolvedEntry | undefined {
	if (entries.length === 0) return undefined;
	const trimmed = selector?.trim();

	if (!trimmed) {
		const entry = entries[0];
		return entry ? { entry, index: 0 } : undefined;
	}

	const byId = entries.find((entry) => entry.id === trimmed);
	if (byId) return { entry: byId, index: entries.indexOf(byId) };

	if (!NUMERIC_SELECTOR_PATTERN.test(trimmed)) return undefined;
	const numeric = Number(trimmed);
	if (Number.isSafeInteger(numeric) && numeric < entries.length) {
		const entry = entries[numeric];
		return entry ? { entry, index: numeric } : undefined;
	}
	return undefined;
}
