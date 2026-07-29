import { strict as assert } from "node:assert";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { isImagePath, persistTmpImages } from "../src/assets.ts";

const PNG_BYTES = Buffer.from("89504e470d0a1a0a", "hex");
const JPEG_BYTES = Buffer.from("ffd8ffe0", "hex");
const GIF_BYTES = Buffer.from("GIF89a", "ascii");
const WEBP_BYTES = Buffer.from("524946460000000057454250", "hex");
const BMP_BYTES = Buffer.from("BM", "ascii");
const IMAGE_BYTES = {
	png: PNG_BYTES,
	jpg: JPEG_BYTES,
	jpeg: JPEG_BYTES,
	gif: GIF_BYTES,
	webp: WEBP_BYTES,
	bmp: BMP_BYTES,
} as const;
const TEST_UUID_PREFIX = "00000000-0000-4000-8000";
const SMALL_IMAGE_LIMITS = {
	maxImageBytes: PNG_BYTES.length,
	maxDraftBytes: PNG_BYTES.length * 2,
	maxImageCount: 2,
};

let scratch: string;
let tmpRoot: string;
let imageSequence: number;

beforeEach(() => {
	scratch = mkdtempSync(path.join(tmpdir(), "pi-stash-assets-"));
	tmpRoot = path.join(scratch, "tmp");
	mkdirSync(tmpRoot, { recursive: true });
	imageSequence = 0;
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function clipboardImage(
	extension: keyof typeof IMAGE_BYTES = "png",
	bytes: Uint8Array = IMAGE_BYTES[extension],
): string {
	imageSequence += 1;
	const suffix = imageSequence.toString().padStart(12, "0");
	const file = path.join(tmpRoot, `pi-clipboard-${TEST_UUID_PREFIX}-${suffix}.${extension}`);
	writeFileSync(file, bytes);
	return file;
}

function missingClipboardImage(extension: keyof typeof IMAGE_BYTES = "png"): string {
	return path.join(tmpRoot, `pi-clipboard-${TEST_UUID_PREFIX}-999999999999.${extension}`);
}

test("isImagePath accepts only direct Pi clipboard-image paths", () => {
	const image = clipboardImage();
	const nested = path.join(tmpRoot, "nested", path.basename(image));
	assert.equal(isImagePath(image, tmpRoot), true);
	assert.equal(isImagePath(nested, tmpRoot), false);
	assert.equal(isImagePath(path.join(scratch, path.basename(image)), tmpRoot), false);
	assert.equal(isImagePath(path.join(tmpRoot, "clip.png"), tmpRoot), false);
	assert.equal(isImagePath("relative/pi-clipboard-id.png", tmpRoot), false);
	assert.equal(isImagePath("", tmpRoot), false);
});

test("isImagePath recognizes every supported clipboard-image suffix exactly", () => {
	for (const extension of Object.keys(IMAGE_BYTES) as Array<keyof typeof IMAGE_BYTES>) {
		assert.equal(isImagePath(clipboardImage(extension), tmpRoot), true);
	}
	assert.equal(
		isImagePath(
			path.join(tmpRoot, `pi-clipboard-${TEST_UUID_PREFIX}-999999999999.png.exe`),
			tmpRoot,
		),
		false,
	);
});

test("persistTmpImages copies exact bytes and rewrites the path", async () => {
	const image = clipboardImage();
	const assetDir = path.join(scratch, "assets", "entry-1");
	const result = await persistTmpImages({ text: `see ${image}`, assetDir, tmpDir: tmpRoot });
	const copiedImage = path.join(assetDir, `00-${path.basename(image)}`);

	assert.equal(result.count, 1);
	assert.notEqual(result.text, `see ${image}`);
	assert.ok(result.text.includes(copiedImage));
	assert.deepEqual(readFileSync(copiedImage), PNG_BYTES);
	assert.equal(statSync(copiedImage).mode & 0o777, 0o600);
});

test("persistTmpImages recognizes supported paths beside prose and punctuation", async () => {
	const first = clipboardImage("png");
	const second = clipboardImage("jpg");
	const assetDir = path.join(scratch, "assets", "punctuation-entry");

	const result = await persistTmpImages({
		text: `before:${first},middle(${second})after`,
		assetDir,
		tmpDir: tmpRoot,
	});

	assert.equal(result.count, 2);
	assert.equal(
		result.text,
		`before:${path.join(assetDir, `00-${path.basename(first)}`)},middle(${path.join(assetDir, `01-${path.basename(second)}`)})after`,
	);
});

test("persistTmpImages leaves repository and unrelated absolute paths untouched", async () => {
	const repoFile = path.join(scratch, "src", "foo.ts");
	mkdirSync(path.dirname(repoFile), { recursive: true });
	writeFileSync(repoFile, "code");
	const assetDir = path.join(scratch, "assets", "entry-2");
	const text = `edit ${repoFile} and ${path.join(scratch, "etc.conf")}`;
	const result = await persistTmpImages({ text, assetDir, tmpDir: tmpRoot });

	assert.equal(result.count, 0);
	assert.equal(result.text, text);
	assert.equal(existsSync(assetDir), false);
});

test("persistTmpImages ignores a clipboard image whose filename is extended by .bak", async () => {
	const image = clipboardImage("png");
	const assetDir = path.join(scratch, "assets", "bak-suffix-entry");
	const text = `keep ${image}.bak untouched`;

	const result = await persistTmpImages({ text, assetDir, tmpDir: tmpRoot });

	assert.equal(result.count, 0);
	assert.equal(result.text, text);
	assert.equal(existsSync(assetDir), false);
});

test("persistTmpImages rejects a missing recognized clipboard image", async () => {
	const missing = missingClipboardImage();
	const assetDir = path.join(scratch, "assets", "missing-entry");

	await assert.rejects(
		() => persistTmpImages({ text: `see ${missing}`, assetDir, tmpDir: tmpRoot }),
		/ENOENT/,
	);
	assert.equal(existsSync(assetDir), false);
});

test("persistTmpImages rejects symbolic-link clipboard images", async () => {
	const target = path.join(scratch, "private.png");
	writeFileSync(target, PNG_BYTES);
	const image = missingClipboardImage();
	symlinkSync(target, image);
	const assetDir = path.join(scratch, "assets", "linked-source");

	await assert.rejects(
		() => persistTmpImages({ text: image, assetDir, tmpDir: tmpRoot }),
		/symbolic link|ELOOP/,
	);
	assert.equal(existsSync(assetDir), false);
});

test("persistTmpImages rejects malformed or extension-mismatched image bytes", async () => {
	const malformed = clipboardImage("png", Buffer.from("not an image"));
	const mismatched = clipboardImage("jpg", PNG_BYTES);
	const assetDir = path.join(scratch, "assets", "malformed-entry");

	await assert.rejects(
		() => persistTmpImages({ text: `${malformed} ${mismatched}`, assetDir, tmpDir: tmpRoot }),
		/invalid png image/,
	);
	assert.equal(existsSync(assetDir), false);
});

test("persistTmpImages deduplicates copied bytes and rewrites every reference", async () => {
	const first = clipboardImage();
	const second = clipboardImage("png", PNG_BYTES);
	const assetDir = path.join(scratch, "assets", "deduplicated-entry");

	const result = await persistTmpImages({
		text: `${first} ${second} ${first}`,
		assetDir,
		tmpDir: tmpRoot,
	});
	const destination = path.join(assetDir, `00-${path.basename(first)}`);

	assert.equal(result.count, 1);
	assert.equal(result.text, `${destination} ${destination} ${destination}`);
	assert.deepEqual(readdirSync(assetDir), [path.basename(destination)]);
});

test("persistTmpImages transfers images from an older owned asset directory", async () => {
	const ownedRoot = path.join(scratch, "owned");
	const oldAssetDir = path.join(ownedRoot, "old-entry");
	mkdirSync(oldAssetDir, { recursive: true });
	const oldImage = path.join(oldAssetDir, "00-clip.png");
	writeFileSync(oldImage, PNG_BYTES);
	const assetDir = path.join(ownedRoot, "new-entry");
	const unrelatedTmp = path.join(scratch, "unrelated-tmp");
	mkdirSync(unrelatedTmp);

	const result = await persistTmpImages({
		text: `restore ${oldImage}`,
		assetDir,
		tmpDir: unrelatedTmp,
		ownedAssetsRoot: ownedRoot,
	});

	assert.equal(result.count, 1);
	assert.ok(result.text.includes(path.join(assetDir, "00-00-clip.png")));
	assert.deepEqual(result.transferredAssetDirs, [oldAssetDir]);
});

test("persistTmpImages enforces the per-image byte boundary", async () => {
	const accepted = clipboardImage();
	const acceptedAssetDir = path.join(scratch, "assets", "accepted-size");
	assert.equal(
		(
			await persistTmpImages({
				text: accepted,
				assetDir: acceptedAssetDir,
				tmpDir: tmpRoot,
				limits: SMALL_IMAGE_LIMITS,
			})
		).count,
		1,
	);

	const oversized = clipboardImage("png", Buffer.concat([PNG_BYTES, Buffer.of(0)]));
	const rejectedAssetDir = path.join(scratch, "assets", "rejected-size");
	await assert.rejects(
		() =>
			persistTmpImages({
				text: oversized,
				assetDir: rejectedAssetDir,
				tmpDir: tmpRoot,
				limits: SMALL_IMAGE_LIMITS,
			}),
		/image exceeds.*byte limit/,
	);
	assert.equal(existsSync(rejectedAssetDir), false);
});

test("persistTmpImages enforces cumulative bytes before creating assets", async () => {
	const first = clipboardImage();
	const second = clipboardImage("png", Buffer.concat([PNG_BYTES, Buffer.of(1)]));
	const assetDir = path.join(scratch, "assets", "cumulative-limit");

	await assert.rejects(
		() =>
			persistTmpImages({
				text: `${first} ${second}`,
				assetDir,
				tmpDir: tmpRoot,
				limits: {
					...SMALL_IMAGE_LIMITS,
					maxImageBytes: PNG_BYTES.length + 1,
					maxDraftBytes: PNG_BYTES.length * 2,
				},
			}),
		/draft images exceed.*byte limit/,
	);
	assert.equal(existsSync(assetDir), false);
});

test("persistTmpImages enforces unique image count before creating assets", async () => {
	const images = [
		clipboardImage(),
		clipboardImage("png", Buffer.concat([PNG_BYTES, Buffer.of(1)])),
		clipboardImage("png", Buffer.concat([PNG_BYTES, Buffer.of(2)])),
	];
	const assetDir = path.join(scratch, "assets", "count-limit");

	await assert.rejects(
		() =>
			persistTmpImages({
				text: images.join(" "),
				assetDir,
				tmpDir: tmpRoot,
				limits: {
					...SMALL_IMAGE_LIMITS,
					maxImageBytes: PNG_BYTES.length + 1,
					maxDraftBytes: PNG_BYTES.length * 3 + 2,
				},
			}),
		/draft exceeds.*image limit/,
	);
	assert.equal(existsSync(assetDir), false);
});

test("persisted image bytes do not depend on the later temporary source", async () => {
	const image = clipboardImage();
	const assetDir = path.join(scratch, "assets", "durable-copy");
	const result = await persistTmpImages({ text: image, assetDir, tmpDir: tmpRoot });
	const persisted = result.text;

	writeFileSync(image, Buffer.from("changed"));
	rmSync(image);

	assert.deepEqual(readFileSync(persisted), PNG_BYTES);
});

test("persistTmpImages copies from one opened descriptor during pathname replacement", async () => {
	const image = clipboardImage();
	const original = `${image}.original`;
	const replacement = Buffer.from("replacement");
	const assetDir = path.join(scratch, "assets", "source-race");
	let sourceOpened = false;

	const result = await persistTmpImages({
		text: image,
		assetDir,
		tmpDir: tmpRoot,
		onSourceOpened: (source) => {
			sourceOpened = true;
			renameSync(source, original);
			writeFileSync(source, replacement);
		},
	});

	assert.equal(sourceOpened, true);
	assert.deepEqual(readFileSync(result.text), PNG_BYTES);
	assert.deepEqual(readFileSync(image), replacement);
});

test("persistTmpImages removes every staged copy when a later write fails", async () => {
	const first = clipboardImage();
	const second = clipboardImage("jpg");
	const assetDir = path.join(scratch, "assets", "rollback-entry");
	mkdirSync(path.join(assetDir, `01-${path.basename(second)}`), { recursive: true });

	await assert.rejects(() =>
		persistTmpImages({ text: `${first} ${second}`, assetDir, tmpDir: tmpRoot }),
	);

	assert.equal(existsSync(assetDir), false);
});

test("persistTmpImages repairs existing asset directory permissions", async () => {
	const image = clipboardImage();
	const assetsRoot = path.join(scratch, "permissive-assets");
	const assetDir = path.join(assetsRoot, "entry-5");
	mkdirSync(assetDir, { recursive: true });
	chmodSync(assetsRoot, 0o755);
	chmodSync(assetDir, 0o755);

	await persistTmpImages({ text: image, assetDir, tmpDir: tmpRoot });

	assert.equal(statSync(assetsRoot).mode & 0o777, 0o700);
	assert.equal(statSync(assetDir).mode & 0o777, 0o700);
});

test("persistTmpImages rejects a symbolic-link asset root", async () => {
	const image = clipboardImage();
	const target = path.join(scratch, "asset-target");
	const assetsRoot = path.join(scratch, "linked-assets");
	mkdirSync(target);
	symlinkSync(target, assetsRoot, "dir");

	await assert.rejects(
		() =>
			persistTmpImages({
				text: image,
				assetDir: path.join(assetsRoot, "entry-6"),
				tmpDir: tmpRoot,
			}),
		/storage directory.*symbolic link/,
	);
	assert.deepEqual(readdirSync(target), []);
});
