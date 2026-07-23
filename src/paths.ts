// Disk layout for pi-stash.
//
// Stashes are scoped per worktree (the realpath of the current working
// directory). A worktree, a bare repo checkout, and a plain non-git folder are
// all just distinct cwd values, so keying on cwd covers every case uniformly
// without any git discovery. The cwd is flattened into a filename-safe string
// by escaping segments and joining them with "--" (e.g. "/Users/me/repo" ->
// "v2--Users--me--repo"), which stays human-readable in `ls ~/.pi/agent/pi-stash`.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import { assertSafeEntryId } from "./types.ts";

// POSIX filenames may not contain "/" or NUL; everything else is legal, so once
// separators are flattened the result is filename-safe on the platforms pi
// targets. 200 keeps the on-disk name readable while staying well under the
// common 255-byte filename limit even after the "-assets" suffix is appended.
const SANITIZE_MAX_LENGTH = 200;
const SEPARATOR = "--";
const KEY_FORMAT_VERSION = "v2";
const KEY_PREFIX = `${KEY_FORMAT_VERSION}${SEPARATOR}`;
const ESCAPE_CHARACTER = "%";
const ESCAPED_ESCAPE_CHARACTER = "%25";
const ESCAPED_SEPARATOR = "%2D%2D";
const BACKSLASH = "\\";
const ESCAPED_BACKSLASH = "%5C";
const HASH_ALGORITHM = "sha256";
const HASH_LENGTH = 16;
const MIN_SANITIZE_LENGTH =
	Buffer.byteLength(KEY_PREFIX) + HASH_LENGTH + Buffer.byteLength(SEPARATOR);

export function sanitizeCwd(cwd: string, options: { maxLength?: number } = {}): string {
	const maxLength = options.maxLength ?? SANITIZE_MAX_LENGTH;
	if (maxLength < MIN_SANITIZE_LENGTH) {
		throw new RangeError(`maxLength must be at least ${MIN_SANITIZE_LENGTH} bytes`);
	}
	const segments = cwd.split("/").filter(Boolean).map(escapeSegment);
	const sanitized = `${KEY_PREFIX}${segments.join(SEPARATOR)}`;
	if (Buffer.byteLength(sanitized) <= maxLength) return sanitized;

	// An unusually deep cwd can overflow a filename. Keep a readable prefix and
	// append a stable hash of the full cwd so two distinct long paths never
	// collide while remaining identifiable.
	const digest = createHash(HASH_ALGORITHM).update(cwd, "utf8").digest("hex").slice(0, HASH_LENGTH);
	const suffix = `${SEPARATOR}${digest}`;
	const prefix = truncateToUtf8Bytes(sanitized, maxLength - Buffer.byteLength(suffix));
	return `${prefix}${suffix}`;
}

function escapeSegment(segment: string): string {
	return segment
		.replaceAll(ESCAPE_CHARACTER, ESCAPED_ESCAPE_CHARACTER)
		.replaceAll(BACKSLASH, ESCAPED_BACKSLASH)
		.replaceAll(SEPARATOR, ESCAPED_SEPARATOR);
}

function truncateToUtf8Bytes(value: string, maxBytes: number): string {
	let bytes = 0;
	let result = "";
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character);
		if (bytes + characterBytes > maxBytes) break;
		result += character;
		bytes += characterBytes;
	}
	return result;
}

export function defaultStashBaseDir(homeDir: string = homedir()): string {
	return path.join(homeDir, ".pi", "agent", "pi-stash");
}

export type StashPaths = {
	/** Flattened cwd, used as the on-disk key. */
	sanitized: string;
	/** JSON file holding the stash entries array for this cwd. */
	stashFile: string;
	/** Directory holding per-entry persisted image assets. */
	assetsRoot: string;
	/** Per-entry asset directory. */
	assetDir(entryId: string): string;
};

export function resolveStashPaths(
	cwd: string,
	baseDir: string = defaultStashBaseDir(),
): StashPaths {
	const sanitized = sanitizeCwd(cwd);
	const assetsRoot = path.join(baseDir, `${sanitized}-assets`);
	return {
		sanitized,
		stashFile: path.join(baseDir, `${sanitized}.json`),
		assetsRoot,
		assetDir: (entryId) => {
			assertSafeEntryId(entryId);
			return path.join(assetsRoot, entryId);
		},
	};
}
