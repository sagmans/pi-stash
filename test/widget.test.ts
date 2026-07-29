import { strict as assert } from "node:assert";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { StashEntry } from "../src/types.ts";
import {
	firstNonEmptyLine,
	themedWidgetLines,
	truncateForWidget,
	type WidgetTheme,
} from "../src/widget.ts";

const theme: WidgetTheme = { fg: (_color, text) => text };

function entry(partial: Partial<StashEntry> = {}): StashEntry {
	return { id: partial.id ?? "id", text: partial.text ?? "draft", createdAt: 1, ...partial };
}

function render(
	entries: readonly StashEntry[],
	options: Parameters<typeof themedWidgetLines>[2] = {},
): string[] {
	return themedWidgetLines(entries, theme, options);
}

test("empty entries render no lines", () => {
	assert.deepEqual(render([]), []);
});

test("renders header and one line per entry with LIFO index", () => {
	const lines = render([entry({ text: "newest" }), entry({ text: "oldest" })], {
		openHint: "X",
	});
	assert.ok(lines[0]?.includes("Stash"));
	assert.ok(lines[1]?.includes("[0]"));
	assert.ok(lines[1]?.includes("newest"));
	assert.ok(lines[2]?.includes("[1]"));
	assert.ok(lines[2]?.includes("oldest"));
});

test("omits the shortcut hint when no binding is available", () => {
	const [header] = render([entry()], { openHint: false });

	assert.equal(header?.includes("to open"), false);
	assert.equal(header?.includes("(false)"), false);
	assert.ok(header?.includes("1"));
});

test("prefers message over first-line preview", () => {
	const lines = render([entry({ text: "body line one\nbody line two", message: "my label" })]);
	assert.ok(lines[1]?.includes("my label"));
	assert.ok(!lines[1]?.includes("body line one"));
});

test("marks only entries with persisted images", () => {
	assert.ok(render([entry({ assetCount: 2 })])[1]?.includes("[img]"));
	assert.ok(!render([entry()])[1]?.includes("[img]"));
});

test("shows five entries and reports fixed-policy overflow", () => {
	const entries = Array.from({ length: 10 }, (_, index) =>
		entry({ id: `id-${index}`, text: `e${index}` }),
	);
	const lines = render(entries);

	assert.equal(lines.length, 7);
	assert.ok(lines.at(-1)?.includes("+5 more"));
});

test("every widget row fits terminal columns at narrow and Unicode boundaries", () => {
	const entries = [
		entry({ message: `e\u0301 ${"界".repeat(20)} 🧑🏽‍💻 family 👨‍👩‍👧‍👦` }),
		entry({ text: "second" }),
	];
	for (const width of [0, 1, 2, 5, 12, 20, 40]) {
		const lines = render(entries, { openHint: "ctrl+x then shift+s to open", width });
		assert.equal(
			lines.some((line) => visibleWidth(line) > width),
			false,
			`row exceeded ${width} columns`,
		);
	}
});

test("firstNonEmptyLine skips blank leading lines", () => {
	assert.equal(firstNonEmptyLine("\n\n  hi\nthere"), "hi");
	assert.equal(firstNonEmptyLine("   "), "");
});

test("truncateForWidget measures terminal columns instead of code units", () => {
	assert.equal(truncateForWidget("short", 10), "short");
	assert.equal(truncateForWidget("abcdefghij", 5), "abcd…");
	assert.equal(visibleWidth(truncateForWidget("界界界", 5)), 5);
	assert.equal(visibleWidth(truncateForWidget("e\u0301e\u0301e\u0301", 2)), 2);
});

test("widget labels cannot emit terminal controls or extra rows", () => {
	const lines = render([entry({ message: "safe\u001b[31m red\u001b[0m\nforged\u202erow" })]);

	assert.equal(lines.length, 2);
	assert.equal(
		lines.some((line) => line.includes("\u001b") || line.includes("\u202e")),
		false,
	);
	assert.ok(lines[1]?.includes("safe red forgedrow"));
});

test("themedWidgetLines routes each region through theme.fg", () => {
	const colors: string[] = [];
	const coloredTheme = {
		fg: (color: string, text: string) => {
			colors.push(color);
			return text;
		},
	};
	const lines = themedWidgetLines(
		[entry({ text: "alpha", assetCount: 1 }), entry({ text: "beta" })],
		coloredTheme,
	);
	assert.ok(lines.length >= 3);
	assert.ok(colors.includes("accent"), "header accented");
	assert.ok(colors.includes("success"), "image marker green");
	assert.ok(colors.includes("muted"), "label muted");
});
