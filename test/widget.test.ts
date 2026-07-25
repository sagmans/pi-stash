import { strict as assert } from "node:assert";
import test from "node:test";
import type { StashEntry } from "../src/types.ts";
import {
	firstNonEmptyLine,
	renderWidgetLines,
	themedWidgetLines,
	truncateForWidget,
} from "../src/widget.ts";

function entry(partial: Partial<StashEntry> = {}): StashEntry {
	return { id: partial.id ?? "id", text: partial.text ?? "draft", createdAt: 1, ...partial };
}

test("empty entries render no lines", () => {
	assert.deepEqual(renderWidgetLines([]), []);
});

test("renders header and one line per entry with LIFO index", () => {
	const lines = renderWidgetLines([entry({ text: "newest" }), entry({ text: "oldest" })], {
		openHint: "X",
		previewWidth: 40,
	});
	assert.ok(lines[0]?.includes("Stash"));
	assert.ok(lines[1]?.includes("[0]"));
	assert.ok(lines[1]?.includes("newest"));
	assert.ok(lines[2]?.includes("[1]"));
	assert.ok(lines[2]?.includes("oldest"));
});

test("prefers message over first-line preview", () => {
	const lines = renderWidgetLines(
		[entry({ text: "body line one\nbody line two", message: "my label" })],
		{ previewWidth: 40 },
	);
	assert.ok(lines[1]?.includes("my label"));
	assert.ok(!lines[1]?.includes("body line one"));
});

test("marks entries with persisted images", () => {
	const lines = renderWidgetLines([entry({ text: "x", assetCount: 2 })], {
		previewWidth: 40,
	});
	assert.ok(lines[1]?.includes("[img]"));
});

test("does not mark entries without images", () => {
	const lines = renderWidgetLines([entry({ text: "x" })], { previewWidth: 40 });
	assert.ok(!lines[1]?.includes("[img]"));
});

test("caps visible lines and reports overflow", () => {
	const entries = Array.from({ length: 10 }, (_, index) =>
		entry({ id: `id-${index}`, text: `e${index}` }),
	);
	const lines = renderWidgetLines(entries, { maxLines: 3, previewWidth: 40 });
	// 1 header + 3 entries + 1 overflow line
	assert.equal(lines.length, 5);
	assert.ok(lines[lines.length - 1]?.includes("+7 more"));
});

test("firstNonEmptyLine skips blank leading lines", () => {
	assert.equal(firstNonEmptyLine("\n\n  hi\nthere"), "hi");
	assert.equal(firstNonEmptyLine("   "), "");
});

test("truncateForWidget adds ellipsis past the width", () => {
	assert.equal(truncateForWidget("short", 10), "short");
	assert.equal(truncateForWidget("abcdefghij", 5), "abcd…");
});

test("widget labels cannot emit terminal controls or extra rows", () => {
	const lines = renderWidgetLines([
		entry({ message: "safe\u001b[31m red\u001b[0m\nforged\u202erow" }),
	]);

	assert.equal(lines.length, 2);
	assert.equal(
		lines.some((line) => line.includes("\u001b") || line.includes("\u202e")),
		false,
	);
	assert.ok(lines[1]?.includes("safe red forgedrow"));
});

test("themedWidgetLines routes each region through theme.fg", () => {
	const colors: string[] = [];
	const theme = {
		fg: (color: string, text: string) => {
			colors.push(color);
			return text;
		},
	};
	const lines = themedWidgetLines(
		[entry({ text: "alpha", assetCount: 1 }), entry({ text: "beta" })],
		theme,
	);
	assert.ok(lines.length >= 3);
	assert.ok(colors.includes("accent"), "header accented");
	assert.ok(colors.includes("success"), "image marker green");
	assert.ok(colors.includes("muted"), "label muted");
});
