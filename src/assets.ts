// Persist tmp-dir image references embedded in a draft so a restored stash never
// points at a file the OS has purged.
//
// When pi pastes an image (Ctrl+V) it writes the bytes into a file under
// os.tmpdir() and inserts that path as text into the editor. Those tmp files
// are ephemeral, so a stashed draft that still points at them can break on
// restore. This module copies every existing tmp-dir image referenced in the
// text into the entry's own asset directory and rewrites the path to the copy.
//
// Non-tmp paths (repo files, absolute system files) are deliberately left
// untouched: they are stable and the user wants to reference the live file at
// restore time, not a frozen snapshot.

import { chmod, copyFile, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./store.ts";
import { isSafeEntryId } from "./types.ts";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

export type PersistResult = {
	text: string;
	/** Number of temporary or previously-owned images copied into the asset dir. */
	count: number;
	/** Older asset directories safe to remove after the new stash commits. */
	transferredAssetDirs: string[];
};

export function isImagePath(candidate: string, tmpDir: string = tmpdir()): boolean {
	if (candidate.length === 0) return false;
	if (!path.isAbsolute(candidate)) return false;
	const normalized = path.resolve(candidate);
	const tmpRoot = path.resolve(tmpDir);
	const relative = path.relative(tmpRoot, normalized);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
		return false;
	}
	return IMAGE_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

export async function persistTmpImages(input: {
	text: string;
	assetDir: string;
	tmpDir?: string;
	ownedAssetsRoot?: string;
}): Promise<PersistResult> {
	const tmpDir = input.tmpDir ?? tmpdir();
	// Split with capturing separators so reconstruction preserves the original
	// whitespace exactly. Pasted image paths never contain spaces, so a
	// whitespace split is sufficient to isolate them as tokens.
	const parts = input.text.split(/(\s+)/);
	const staged = new Map<string, string>();
	const rewrites: Array<{ at: number; replacement: string }> = [];
	const transferredAssetDirs = new Set<string>();
	let count = 0;

	for (let index = 0; index < parts.length; index += 1) {
		const token = parts[index];
		if (token === undefined) continue;
		const ownedAssetDir = input.ownedAssetsRoot
			? resolveOwnedAssetDir(token, input.ownedAssetsRoot)
			: undefined;
		if (!isImagePath(token, tmpDir) && !ownedAssetDir) continue;
		const exists = await stat(token).then(
			() => true,
			() => false,
		);
		if (!exists) continue;

		const stagedPath = staged.get(token) ?? stageCopy(token, input.assetDir, count);
		staged.set(token, stagedPath);
		rewrites.push({ at: index, replacement: stagedPath });
		if (ownedAssetDir && path.resolve(ownedAssetDir) !== path.resolve(input.assetDir)) {
			transferredAssetDirs.add(ownedAssetDir);
		}
		count += 1;
	}

	if (count === 0) {
		// No assets to keep: leave nothing behind so an empty asset dir never
		// accumulates across stashes.
		await rm(input.assetDir, { force: true, recursive: true });
		return { text: input.text, count: 0, transferredAssetDirs: [] };
	}

	await mkdir(input.assetDir, { recursive: true, mode: PRIVATE_DIR_MODE });
	for (const { at, replacement } of rewrites) {
		const source = parts[at];
		if (source === undefined) continue;
		await copyFile(source, replacement);
		await chmod(replacement, PRIVATE_FILE_MODE);
		parts[at] = replacement;
	}

	return { text: parts.join(""), count, transferredAssetDirs: [...transferredAssetDirs] };
}

function resolveOwnedAssetDir(candidate: string, assetsRoot: string): string | undefined {
	if (!path.isAbsolute(candidate) || !IMAGE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) {
		return undefined;
	}
	const root = path.resolve(assetsRoot);
	const relative = path.relative(root, path.resolve(candidate));
	if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	const segments = relative.split(path.sep);
	if (segments.length !== 2) return undefined;
	const entryId = segments[0];
	if (!entryId || !isSafeEntryId(entryId)) return undefined;
	return path.join(root, entryId);
}

// Build a collision-free destination path inside the asset dir. A sequential
// index plus the original basename keeps copies human-inspectable while
// guaranteeing that two different tmp files with the same name do not clobber
// each other.
function stageCopy(source: string, assetDir: string, index: number): string {
	const base = path.basename(source);
	return path.join(assetDir, `${index.toString().padStart(2, "0")}-${base}`);
}

export async function removeAssetDir(assetDir: string): Promise<void> {
	await rm(assetDir, { force: true, recursive: true });
}
