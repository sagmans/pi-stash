import { strict as assert } from "node:assert";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
	assertRegularOwnedFile,
	ensurePrivateDirectory,
	hasErrorCode,
	pathExists,
	quarantinePrivateFile,
	readPrivateTextFile,
	removePrivateDirectory,
	writePrivateFileExclusive,
} from "../src/private-fs.ts";

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(path.join(tmpdir(), "pi-stash-private-fs-"));
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

test("ensurePrivateDirectory creates and repairs a private directory", async () => {
	const directory = path.join(scratch, "private");
	await ensurePrivateDirectory(directory);
	assert.equal(statSync(directory).mode & 0o777, 0o700);
});

test("readPrivateTextFile rejects a link and preserves its target", async () => {
	const target = path.join(scratch, "target");
	const linkedFile = path.join(scratch, "linked");
	writeFileSync(target, "secret");
	symlinkSync(target, linkedFile);

	await assert.rejects(() => readPrivateTextFile(linkedFile), /symbolic link/);
	assert.equal(readFileSync(target, "utf8"), "secret");
});

test("writePrivateFileExclusive writes text and bytes without overwriting", async () => {
	const textFile = path.join(scratch, "text");
	const bytesFile = path.join(scratch, "bytes");
	await writePrivateFileExclusive(textFile, "text");
	await writePrivateFileExclusive(bytesFile, Buffer.from([0, 1, 2]));

	await assert.rejects(() => writePrivateFileExclusive(textFile, "replace"), { code: "EEXIST" });
	assert.equal(readFileSync(textFile, "utf8"), "text");
	assert.deepEqual(readFileSync(bytesFile), Buffer.from([0, 1, 2]));
});

test("quarantinePrivateFile preserves collisions and removes only its source", async () => {
	const file = path.join(scratch, "state");
	const collision = `${file}.corrupt`;
	writeFileSync(file, "broken");
	writeFileSync(collision, "older evidence");
	const { identity } = await readPrivateTextFile(file);

	const quarantined = await quarantinePrivateFile(file, identity, "corrupt");

	assert.equal(quarantined, `${collision}-1`);
	assert.equal(readFileSync(collision, "utf8"), "older evidence");
	assert.equal(readFileSync(quarantined, "utf8"), "broken");
	assert.equal(existsSync(file), false);
});

test("shared validation helpers preserve lstat and ownership semantics", async () => {
	const missing = path.join(scratch, "missing");
	assert.equal(await pathExists(missing), false);
	assert.equal(hasErrorCode({ code: "ENOENT" }, "ENOENT"), true);
	assert.equal(hasErrorCode(null, "ENOENT"), false);

	const regularFile = path.join(scratch, "regular");
	writeFileSync(regularFile, "keep");
	assertRegularOwnedFile(statSync(regularFile), "test file");
	assert.throws(() => assertRegularOwnedFile(statSync(scratch), "test file"), /regular file/);
});

test("removePrivateDirectory ignores absence but rejects regular files", async () => {
	const missing = path.join(scratch, "missing");
	await removePrivateDirectory(missing);
	const regularFile = path.join(scratch, "regular");
	writeFileSync(regularFile, "keep");

	await assert.rejects(() => removePrivateDirectory(regularFile), /must be a directory/);
	assert.equal(readFileSync(regularFile, "utf8"), "keep");
});
