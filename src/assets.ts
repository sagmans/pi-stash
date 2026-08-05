// Persist Pi clipboard-image references into private stash-owned storage.
// Sources are opened once without following links, validated against their
// canonical ownership boundary, and copied from that descriptor so pathname
// replacement cannot change the bytes committed to a stash.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	assertPrivateDirectory,
	assertRegularOwnedFile,
	ensurePrivateDirectory,
	removePrivateDirectory,
	syncPrivateDirectory,
	writePrivateFileExclusive,
} from "./private-fs.ts";
import { isSafeEntryId } from "./types.ts";

const BYTES_PER_MEBIBYTE = 1024 * 1024;
export const MAX_IMAGE_BYTES = 20 * BYTES_PER_MEBIBYTE;
export const MAX_DRAFT_IMAGE_BYTES = 50 * BYTES_PER_MEBIBYTE;
export const MAX_DRAFT_IMAGE_COUNT = 10;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const IMAGE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp|bmp)(?![./\\\p{L}\p{N}_-])/giu;
const PI_CLIPBOARD_IMAGE_PATTERN =
	/^pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp|bmp)$/u;
const MAX_IMAGE_PATH_LENGTH = 4096;
const READ_CHUNK_BYTES = 64 * 1024;
const HASH_ALGORITHM = "sha256";
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const JPEG_SIGNATURE = Buffer.from("ffd8ff", "hex");
const GIF87_SIGNATURE = Buffer.from("GIF87a", "ascii");
const GIF89_SIGNATURE = Buffer.from("GIF89a", "ascii");
const RIFF_SIGNATURE = Buffer.from("RIFF", "ascii");
const WEBP_SIGNATURE = Buffer.from("WEBP", "ascii");
const BMP_SIGNATURE = Buffer.from("BM", "ascii");
const IMAGE_LIMIT_MESSAGE = "image exceeds per-image byte limit";
const DRAFT_BYTE_LIMIT_MESSAGE = "draft images exceed cumulative byte limit";
const DRAFT_COUNT_LIMIT_MESSAGE = "draft exceeds persisted image limit";
const COPY_ROLLBACK_MESSAGE = "image copy and rollback both failed";
const NO_FOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;

export type ImageLimits = {
	maxImageBytes: number;
	maxDraftBytes: number;
	maxImageCount: number;
};

type ImageReference = {
	start: number;
	end: number;
	source: string;
	ownedAssetDir?: string;
};

type LoadedImage = {
	bytes: Buffer;
	digest: string;
};

type PlannedCopy = LoadedImage & {
	destination: string;
};

type PersistInput = {
	text: string;
	assetDir: string;
	tmpDir?: string;
	ownedAssetsRoot?: string;
	limits?: Partial<ImageLimits>;
	/** Test/diagnostic seam for proving reads stay bound to the opened source inode. */
	onSourceOpened?: (source: string) => void | Promise<void>;
};

export type PersistResult = {
	text: string;
	/** Number of distinct image byte sequences copied into the asset directory. */
	count: number;
	/** Older asset ids safe to remove after the new stash commits. */
	transferredAssetIds: string[];
};

export function isImagePath(candidate: string, tmpDir: string = tmpdir()): boolean {
	if (!path.isAbsolute(candidate)) return false;
	const normalized = path.resolve(candidate);
	const tmpRoot = path.resolve(tmpDir);
	return (
		path.dirname(normalized) === tmpRoot &&
		PI_CLIPBOARD_IMAGE_PATTERN.test(path.basename(normalized))
	);
}

export async function persistTmpImages(input: PersistInput): Promise<PersistResult> {
	const tmpRoot = input.tmpDir ?? tmpdir();
	const limits = resolveLimits(input.limits);
	const references = findImageReferences(input.text, tmpRoot, input.ownedAssetsRoot);
	if (references.length === 0) {
		await removePrivateDirectory(input.assetDir);
		return { text: input.text, count: 0, transferredAssetIds: [] };
	}

	const loadedBySource = new Map<string, LoadedImage>();
	const copiesByDigest = new Map<string, PlannedCopy>();
	const destinationBySource = new Map<string, string>();
	const transferredAssetIds = new Set<string>();
	let totalBytes = 0;

	for (const reference of references) {
		let loaded = loadedBySource.get(reference.source);
		if (!loaded) {
			loaded = await loadImage(
				reference,
				tmpRoot,
				input.ownedAssetsRoot,
				limits.maxImageBytes,
				input.onSourceOpened,
			);
			loadedBySource.set(reference.source, loaded);
		}
		let copy = copiesByDigest.get(loaded.digest);
		if (!copy) {
			if (copiesByDigest.size >= limits.maxImageCount) throw new Error(DRAFT_COUNT_LIMIT_MESSAGE);
			totalBytes += loaded.bytes.length;
			if (totalBytes > limits.maxDraftBytes) throw new Error(DRAFT_BYTE_LIMIT_MESSAGE);
			copy = {
				...loaded,
				destination: stageCopy(reference.source, input.assetDir, copiesByDigest.size),
			};
			copiesByDigest.set(loaded.digest, copy);
		}
		destinationBySource.set(reference.source, copy.destination);
		if (
			reference.ownedAssetDir &&
			path.resolve(reference.ownedAssetDir) !== path.resolve(input.assetDir)
		) {
			transferredAssetIds.add(path.basename(reference.ownedAssetDir));
		}
	}

	try {
		await ensurePrivateDirectory(path.dirname(input.assetDir));
		await ensurePrivateDirectory(input.assetDir);
		for (const copy of copiesByDigest.values()) {
			await writePrivateFileExclusive(copy.destination, copy.bytes);
		}
		await syncPrivateDirectory(input.assetDir, "asset directory");
		await syncPrivateDirectory(path.dirname(input.assetDir));
	} catch (error) {
		try {
			await removePrivateDirectory(input.assetDir);
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], COPY_ROLLBACK_MESSAGE);
		}
		throw error;
	}

	let text = input.text;
	for (const reference of [...references].reverse()) {
		const replacement = destinationBySource.get(reference.source);
		if (replacement) {
			text = `${text.slice(0, reference.start)}${replacement}${text.slice(reference.end)}`;
		}
	}
	return {
		text,
		count: copiesByDigest.size,
		transferredAssetIds: [...transferredAssetIds],
	};
}

function resolveLimits(overrides: Partial<ImageLimits> | undefined): ImageLimits {
	const limits = {
		maxImageBytes: overrides?.maxImageBytes ?? MAX_IMAGE_BYTES,
		maxDraftBytes: overrides?.maxDraftBytes ?? MAX_DRAFT_IMAGE_BYTES,
		maxImageCount: overrides?.maxImageCount ?? MAX_DRAFT_IMAGE_COUNT,
	};
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value <= 0)
			throw new RangeError(`${name} must be positive`);
	}
	return limits;
}

function findImageReferences(
	text: string,
	tmpRoot: string,
	ownedAssetsRoot?: string,
): ImageReference[] {
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

async function loadImage(
	reference: ImageReference,
	tmpRoot: string,
	ownedAssetsRoot: string | undefined,
	maxBytes: number,
	onSourceOpened: PersistInput["onSourceOpened"],
): Promise<LoadedImage> {
	const before = await lstat(reference.source);
	assertRegularOwnedFile(before, "image source");
	await assertCanonicalBoundary(reference, tmpRoot, ownedAssetsRoot);
	if (before.size > maxBytes) throw new Error(IMAGE_LIMIT_MESSAGE);

	const handle = await open(reference.source, constants.O_RDONLY | NO_FOLLOW_FLAG);
	try {
		const opened = await handle.stat();
		assertRegularOwnedFile(opened, "image source");
		if (opened.dev !== before.dev || opened.ino !== before.ino) {
			throw new Error("image source changed during validation");
		}
		await onSourceOpened?.(reference.source);
		const bytes = await readBounded(handle, maxBytes);
		assertImageBytes(reference.source, bytes);
		return {
			bytes,
			digest: createHash(HASH_ALGORITHM).update(bytes).digest("hex"),
		};
	} finally {
		await handle.close();
	}
}

async function assertCanonicalBoundary(
	reference: ImageReference,
	tmpRoot: string,
	ownedAssetsRoot: string | undefined,
): Promise<void> {
	const canonicalSource = await realpath(reference.source);
	if (!reference.ownedAssetDir) {
		const canonicalTmpRoot = await realpath(tmpRoot);
		if (path.dirname(canonicalSource) !== canonicalTmpRoot) {
			throw new Error("image source is outside the temporary image boundary");
		}
		return;
	}
	if (!ownedAssetsRoot) throw new Error("owned image source has no ownership root");
	await assertPrivateDirectory(reference.ownedAssetDir, "owned asset directory");
	const canonicalRoot = await realpath(ownedAssetsRoot);
	const canonicalAssetDir = await realpath(reference.ownedAssetDir);
	const relativeAssetDir = path.relative(canonicalRoot, canonicalAssetDir);
	if (!isDirectChild(relativeAssetDir) || path.dirname(canonicalSource) !== canonicalAssetDir) {
		throw new Error("owned image source is outside its asset boundary");
	}
}

async function readBounded(handle: FileHandle, maxBytes: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	while (totalBytes <= maxBytes) {
		const remaining = maxBytes + 1 - totalBytes;
		const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, remaining));
		const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
		if (bytesRead === 0) break;
		chunks.push(chunk.subarray(0, bytesRead));
		totalBytes += bytesRead;
	}
	if (totalBytes > maxBytes) throw new Error(IMAGE_LIMIT_MESSAGE);
	return Buffer.concat(chunks, totalBytes);
}

function assertImageBytes(source: string, bytes: Buffer): void {
	const extension = path.extname(source).toLowerCase();
	const valid = (() => {
		switch (extension) {
			case ".png":
				return bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
			case ".jpg":
			case ".jpeg":
				return bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE);
			case ".gif":
				return (
					bytes.subarray(0, GIF87_SIGNATURE.length).equals(GIF87_SIGNATURE) ||
					bytes.subarray(0, GIF89_SIGNATURE.length).equals(GIF89_SIGNATURE)
				);
			case ".webp":
				return (
					bytes.subarray(0, RIFF_SIGNATURE.length).equals(RIFF_SIGNATURE) &&
					bytes.subarray(8, 8 + WEBP_SIGNATURE.length).equals(WEBP_SIGNATURE)
				);
			case ".bmp":
				return bytes.subarray(0, BMP_SIGNATURE.length).equals(BMP_SIGNATURE);
			default:
				return false;
		}
	})();
	if (!valid) throw new Error(`invalid ${extension.slice(1)} image`);
}

function resolveOwnedAssetDir(candidate: string, assetsRoot: string): string | undefined {
	if (!path.isAbsolute(candidate) || !IMAGE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) {
		return undefined;
	}
	const root = path.resolve(assetsRoot);
	const relative = path.relative(root, path.resolve(candidate));
	const segments = relative.split(path.sep);
	if (!isWithin(relative) || segments.length !== 2) return undefined;
	const entryId = segments[0];
	if (!entryId || !isSafeEntryId(entryId)) return undefined;
	return path.join(root, entryId);
}

function isWithin(relative: string): boolean {
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isDirectChild(relative: string): boolean {
	return isWithin(relative) && relative.length > 0 && !relative.includes(path.sep);
}

function stageCopy(source: string, assetDir: string, index: number): string {
	const base = path.basename(source);
	return path.join(assetDir, `${index.toString().padStart(2, "0")}-${base}`);
}
