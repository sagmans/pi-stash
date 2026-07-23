import { strict as assert } from "node:assert";
import test from "node:test";

import {
	createEmptyStashFile,
	normalizeEntry,
	normalizeStashFile,
	resolveBySelector,
	STASH_SCHEMA_VERSION,
	type StashEntry,
} from "../src/types.ts";

const VALID_ENTRY: StashEntry = { id: "id-1", text: "hello", createdAt: 1000 };
const INVALID_DATE_TIMESTAMP = 8_640_000_000_000_001;

test("normalizeEntry accepts a minimal valid entry", () => {
	assert.deepEqual(normalizeEntry(VALID_ENTRY), VALID_ENTRY);
});

test("normalizeEntry accepts optional message and assetCount", () => {
	assert.deepEqual(normalizeEntry({ ...VALID_ENTRY, message: "msg", assetCount: 2 }), {
		...VALID_ENTRY,
		message: "msg",
		assetCount: 2,
	});
});

test("normalizeEntry rejects missing id or non-string text", () => {
	assert.equal(normalizeEntry({ text: "x", createdAt: 1 }), undefined);
	assert.equal(normalizeEntry({ id: "x", text: 5, createdAt: 1 }), undefined);
	assert.equal(normalizeEntry({ id: "", text: "x", createdAt: 1 }), undefined);
	assert.equal(normalizeEntry({ id: "x", text: "x", createdAt: "bad" }), undefined);
	assert.equal(normalizeEntry({ ...VALID_ENTRY, assetCount: -1 }), undefined);
	assert.equal(normalizeEntry({ ...VALID_ENTRY, id: "../escape" }), undefined);
	assert.equal(normalizeEntry({ ...VALID_ENTRY, id: "." }), undefined);
	assert.equal(normalizeEntry({ ...VALID_ENTRY, createdAt: INVALID_DATE_TIMESTAMP }), undefined);
});

test("normalizeStashFile rejects wrong schema version and bad entries", () => {
	const base = createEmptyStashFile("--cwd", 1);
	assert.equal(normalizeStashFile({ ...base, schemaVersion: 999 }), undefined);
	assert.equal(normalizeStashFile({ ...base, entries: [{ id: "x" }] }), undefined);
	assert.equal(normalizeStashFile({ ...base, updatedAt: INVALID_DATE_TIMESTAMP }), undefined);
});

test("normalizeStashFile round-trips a valid file", () => {
	const file = {
		schemaVersion: STASH_SCHEMA_VERSION,
		cwd: "--cwd",
		createdAt: 1,
		updatedAt: 2,
		entries: [VALID_ENTRY],
	};
	assert.deepEqual(normalizeStashFile(file), file);
});

test("resolveBySelector returns undefined for empty list", () => {
	assert.equal(resolveBySelector([], undefined), undefined);
	assert.equal(resolveBySelector([], "0"), undefined);
});

function entries(...ids: string[]): StashEntry[] {
	return ids.map((id, index) => ({ id, text: `t-${id}`, createdAt: index }));
}

test("resolveBySelector defaults to newest (index 0)", () => {
	const list = entries("a", "b", "c"); // a is newest
	const resolved = resolveBySelector(list, undefined);
	assert.equal(resolved?.entry.id, "a");
	assert.equal(resolved?.index, 0);
});

test("resolveBySelector resolves by numeric index", () => {
	const list = entries("a", "b", "c");
	assert.equal(resolveBySelector(list, "2")?.entry.id, "c");
	assert.equal(resolveBySelector(list, "2")?.index, 2);
});

test("resolveBySelector resolves by id even if it looks numeric elsewhere", () => {
	const list = entries("a", "b");
	assert.equal(resolveBySelector(list, "b")?.entry.id, "b");
});

test("resolveBySelector returns undefined for out-of-range or unknown", () => {
	const list = entries("a", "b");
	assert.equal(resolveBySelector(list, "9"), undefined);
	assert.equal(resolveBySelector(list, "1oops"), undefined);
	assert.equal(resolveBySelector(list, "1.5"), undefined);
	assert.equal(resolveBySelector(list, "nope"), undefined);
});
