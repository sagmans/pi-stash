import { strict as assert } from "node:assert";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { isImagePath, persistTmpImages, removeAssetDir } from "../src/assets.ts";

let scratch: string;
let tmpRoot: string;

beforeEach(() => {
	scratch = mkdtempSync(path.join(tmpdir(), "pi-stash-assets-"));
	tmpRoot = path.join(scratch, "tmp");
	mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function tmpImage(name: string): string {
	const file = path.join(tmpRoot, name);
	writeFileSync(file, "png-bytes");
	return file;
}

test("isImagePath only accepts absolute tmp-dir image paths", () => {
	const img = tmpImage("x.png");
	assert.equal(isImagePath(img, tmpRoot), true);
	assert.equal(isImagePath(path.join(scratch, "repo.png"), tmpRoot), false);
	assert.equal(isImagePath("relative/x.png", tmpRoot), false);
	assert.equal(isImagePath(path.join(tmpRoot, "notes.txt"), tmpRoot), false);
	assert.equal(isImagePath("", tmpRoot), false);
});

test("persistTmpImages copies a tmp image and rewrites the path", async () => {
	const img = tmpImage("clip.png");
	const assetDir = path.join(scratch, "assets", "entry-1");
	const result = await persistTmpImages({ text: `see ${img}`, assetDir, tmpDir: tmpRoot });

	assert.equal(result.count, 1);
	assert.notEqual(result.text, `see ${img}`);
	assert.ok(result.text.includes(path.join(assetDir, "00-clip.png")));
	const copiedImage = path.join(assetDir, "00-clip.png");
	assert.ok(existsSync(copiedImage));
	assert.equal(statSync(copiedImage).mode & 0o777, 0o600);
});

test("persistTmpImages recognizes spaced paths beside prose and punctuation", async () => {
	const spacedRoot = path.join(scratch, "tmp root");
	mkdirSync(spacedRoot);
	const first = path.join(spacedRoot, "clip one.png");
	const second = path.join(spacedRoot, "clip two.jpg");
	writeFileSync(first, "one");
	writeFileSync(second, "two");
	const assetDir = path.join(scratch, "assets", "spaced-entry");

	const result = await persistTmpImages({
		text: `before:${first},middle(${second})after`,
		assetDir,
		tmpDir: spacedRoot,
	});

	assert.equal(result.count, 2);
	assert.equal(
		result.text,
		`before:${path.join(assetDir, "00-clip one.png")},middle(${path.join(assetDir, "01-clip two.jpg")})after`,
	);
});

test("persistTmpImages leaves repo/absolute paths untouched", async () => {
	const repoFile = path.join(scratch, "src", "foo.ts");
	mkdirSync(path.dirname(repoFile), { recursive: true });
	writeFileSync(repoFile, "code");
	const assetDir = path.join(scratch, "assets", "entry-2");
	const text = `edit ${repoFile} and ${path.join(scratch, "etc.conf")}`;
	const result = await persistTmpImages({ text, assetDir, tmpDir: tmpRoot });

	assert.equal(result.count, 0);
	assert.equal(result.text, text);
	assert.equal(existsSync(assetDir), false, "no asset dir should be created");
});

test("persistTmpImages skips missing tmp files", async () => {
	const ghost = path.join(tmpRoot, "missing.png");
	const assetDir = path.join(scratch, "assets", "entry-3");
	const result = await persistTmpImages({ text: `see ${ghost}`, assetDir, tmpDir: tmpRoot });

	assert.equal(result.count, 0);
	assert.equal(result.text, `see ${ghost}`);
});

test("persistTmpImages transfers images from an older owned asset directory", async () => {
	const ownedRoot = path.join(scratch, "owned");
	const oldAssetDir = path.join(ownedRoot, "old-entry");
	mkdirSync(oldAssetDir, { recursive: true });
	const oldImage = path.join(oldAssetDir, "00-clip.png");
	writeFileSync(oldImage, "png-bytes");
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

test("persistTmpImages handles multiple images with distinct copies", async () => {
	const a = tmpImage("a.png");
	const b = tmpImage("b.jpg");
	const assetDir = path.join(scratch, "assets", "entry-4");
	const result = await persistTmpImages({
		text: `${a} ${b}`,
		assetDir,
		tmpDir: tmpRoot,
	});

	assert.equal(result.count, 2);
	assert.ok(existsSync(path.join(assetDir, "00-a.png")));
	assert.ok(existsSync(path.join(assetDir, "01-b.jpg")));
});

test("persistTmpImages removes every staged copy when a later copy fails", async () => {
	const a = tmpImage("a.png");
	const b = tmpImage("b.jpg");
	const assetDir = path.join(scratch, "assets", "rollback-entry");
	mkdirSync(path.join(assetDir, "01-b.jpg"), { recursive: true });

	await assert.rejects(() => persistTmpImages({ text: `${a} ${b}`, assetDir, tmpDir: tmpRoot }));

	assert.equal(existsSync(assetDir), false);
});

test("persistTmpImages repairs existing asset directory permissions", async () => {
	const image = tmpImage("private.png");
	const assetsRoot = path.join(scratch, "permissive-assets");
	const assetDir = path.join(assetsRoot, "entry-5");
	mkdirSync(assetDir, { recursive: true });
	chmodSync(assetsRoot, 0o755);
	chmodSync(assetDir, 0o755);

	await persistTmpImages({ text: image, assetDir, tmpDir: tmpRoot });

	assert.equal(statSync(assetsRoot).mode & 0o777, 0o700);
	assert.equal(statSync(assetDir).mode & 0o777, 0o700);
});

test("removeAssetDir deletes the directory", async () => {
	const assetDir = path.join(scratch, "assets", "entry-5");
	mkdirSync(assetDir, { recursive: true });
	writeFileSync(path.join(assetDir, "00-x.png"), "x");
	await removeAssetDir(assetDir);
	assert.equal(existsSync(assetDir), false);
});
