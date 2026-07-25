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

import { constants } from "node:fs";
import { chmod, copyFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensurePrivateDirectory, PRIVATE_FILE_MODE, removePrivateDirectory } from "./private-fs.ts";
import { isSafeEntryId } from "./types.ts";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const IMAGE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp|bmp)/giu;
const MAX_IMAGE_PATH_LENGTH = 4096;

type ImageReference = {
	start: number;
	end: number;
	source: string;
	ownedAssetDir?: string;
};

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
	const references = await findImageReferences(input.text, tmpDir, input.ownedAssetsRoot);
	const staged = new Map<string, string>();
	const transferredAssetDirs = new Set<string>();

	for (const reference of references) {
		if (!staged.has(reference.source)) {
			staged.set(reference.source, stageCopy(reference.source, input.assetDir, staged.size));
		}
		if (
			reference.ownedAssetDir &&
			path.resolve(reference.ownedAssetDir) !== path.resolve(input.assetDir)
		) {
			transferredAssetDirs.add(reference.ownedAssetDir);
		}
	}

	if (staged.size === 0) {
		// No assets to keep: leave nothing behind so an empty asset dir never
		// accumulates across stashes.
		await removePrivateDirectory(input.assetDir);
		return { text: input.text, count: 0, transferredAssetDirs: [] };
	}

	try {
		await ensurePrivateDirectory(path.dirname(input.assetDir));
		await ensurePrivateDirectory(input.assetDir);
		for (const [source, destination] of staged) {
			await copyFile(source, destination, constants.COPYFILE_EXCL);
			await chmod(destination, PRIVATE_FILE_MODE);
		}
	} catch (error) {
		// Entry ids are unique, so the entire staging directory belongs to this
		// failed transaction and can be removed without affecting older stashes.
		await removePrivateDirectory(input.assetDir);
		throw error;
	}

	let text = input.text;
	for (const reference of [...references].reverse()) {
		const replacement = staged.get(reference.source);
		if (replacement) {
			text = `${text.slice(0, reference.start)}${replacement}${text.slice(reference.end)}`;
		}
	}
	return {
		text,
		count: staged.size,
		transferredAssetDirs: [...transferredAssetDirs],
	};
}

async function findImageReferences(
	text: string,
	tmpRoot: string,
	ownedAssetsRoot?: string,
): Promise<ImageReference[]> {
	const roots = [...new Set([tmpRoot, ownedAssetsRoot].filter((root): root is string => !!root))]
		.map((root) => path.resolve(root))
		.sort((left, right) => right.length - left.length);
	const referencesByStart = new Map<number, ImageReference>();

	for (const root of roots) {
		let start = text.indexOf(root);
		while (start >= 0) {
			const searchEnd = Math.min(text.length, start + MAX_IMAGE_PATH_LENGTH);
			const segment = text.slice(start, searchEnd);
			let found: ImageReference | undefined;
			for (const match of segment.matchAll(IMAGE_EXTENSION_PATTERN)) {
				const end = start + (match.index ?? 0) + match[0].length;
				const source = text.slice(start, end);
				const ownedAssetDir = ownedAssetsRoot
					? resolveOwnedAssetDir(source, ownedAssetsRoot)
					: undefined;
				if (!isImagePath(source, tmpRoot) && !ownedAssetDir) continue;
				const sourceStat = await stat(source).catch(() => undefined);
				if (!sourceStat?.isFile()) continue;
				// Longest existing candidate preserves valid filenames containing an
				// image-looking suffix before their real final extension.
				found = { start, end, source, ownedAssetDir };
			}
			if (found && found.end > (referencesByStart.get(start)?.end ?? -1)) {
				referencesByStart.set(start, found);
			}
			start = text.indexOf(root, start + root.length);
		}
	}

	const references = [...referencesByStart.values()].sort(
		(left, right) => left.start - right.start,
	);
	return references.filter(
		(reference, index) => index === 0 || reference.start >= (references[index - 1]?.end ?? 0),
	);
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
	await removePrivateDirectory(assetDir);
}
