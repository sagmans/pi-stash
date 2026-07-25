import { strict as assert } from "node:assert";
import test from "node:test";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";

import {
	detailBody,
	detailFooter,
	detailHeader,
	headerLine,
	type KeyMatcher,
	listFooter,
	listRow,
	type OverlayTheme,
	relativeAge,
	StashOverlayComponent,
} from "../src/overlay.ts";
import type { StashEntry } from "../src/types.ts";

// Identity theme keeps assertions free of ANSI codes.
const theme: OverlayTheme = { fg: (_color, text) => text, bold: (text) => text };

function entry(id: string, text: string, opts: Partial<StashEntry> = {}): StashEntry {
	return { id, text, createdAt: 1, ...opts };
}

// ---------- pure helpers ----------

test("relativeAge crosses minute/hour/day boundaries", () => {
	const now = 1_000_000_000_000;
	assert.equal(relativeAge(now, now), "now");
	assert.equal(relativeAge(now - 5 * 60_000, now), "5m");
	assert.equal(relativeAge(now - 3 * 3_600_000, now), "3h");
	assert.equal(relativeAge(now - 2 * 86_400_000, now), "2d");
});

test("listRow accents the selected row and badges image count", () => {
	const item = { entry: entry("a", "alpha", { assetCount: 2 }), index: 0 };
	const selected = listRow(item, true, theme);
	const idle = listRow(item, false, theme);
	assert.ok(selected.startsWith("▸"));
	assert.ok(idle.startsWith("  "));
	assert.ok(selected.includes("[0]"));
	assert.ok(selected.includes("alpha"));
	assert.ok(selected.includes("⬗2"));
});

test("headerLine renders title, tally, and cwd", () => {
	const line = headerLine(3, "~/repo", theme);
	assert.ok(line.includes("Stash"));
	assert.ok(line.includes("3 drafts"));
	assert.ok(line.includes("~/repo"));
	assert.ok(!headerLine(1, "x", theme).includes("drafts"));
});

test("footers mention restore and their mode-specific actions", () => {
	assert.ok(listFooter(theme).includes("restore"));
	assert.ok(listFooter(theme).includes("filter"));
	assert.ok(detailFooter(theme).includes("drop"));
});

test("detailBody prepends a note when present", () => {
	const withNote = detailBody(
		{ entry: entry("a", "body", { message: "ship it" }), index: 0 },
		theme,
	);
	assert.ok(withNote[0]?.includes("ship it"));
	assert.ok(withNote[1]?.includes("body"));
	const noNote = detailBody({ entry: entry("a", "body"), index: 0 }, theme);
	assert.equal(noNote.length, 1);
});

test("overlay text sanitizes terminal controls without losing draft line structure", () => {
	const item = {
		entry: entry("a", "line one\nline \u001b[2Jtwo", {
			message: "note\u001b]8;;https://evil.invalid\u0007link\u001b]8;;\u0007",
		}),
		index: 0,
	};
	const body = detailBody(item, theme);
	const row = listRow(item, true, theme);
	const header = headerLine(1, "repo\u202ename", theme);

	assert.equal(
		[row, header, ...body].some((value) => value.includes("\u001b")),
		false,
	);
	assert.equal(header.includes("\u202e"), false);
	assert.equal(body[1], "line one\nline two");
	assert.ok(body[0]?.includes("notelink"));
});

test("detailHeader shows index and image count", () => {
	const line = detailHeader({ entry: entry("a", "x", { assetCount: 2 }), index: 0 }, theme);
	assert.ok(line.includes("[0]"));
	assert.ok(line.includes("⬗2"));
});

// ---------- component behavior ----------

// Fake matcher: maps a fixed glyph per keybinding action so tests stay independent
// of the global keybinding table.
const KEY_GLYPH: Record<string, string> = {
	"tui.select.up": "U",
	"tui.select.down": "D",
	"tui.select.confirm": "E",
	"tui.select.cancel": "X",
};
const matcher: KeyMatcher = (data, action) => KEY_GLYPH[action] === data;

type Calls = { restore: StashEntry[]; drop: StashEntry[]; close: number };
function harness(entries: StashEntry[], dropResult: boolean | Promise<boolean> = true) {
	const calls: Calls = { restore: [], drop: [], close: 0 };
	const renders: number[] = [];
	const overlay = new StashOverlayComponent(
		{ requestRender: () => renders.push(renders.length) },
		theme,
		entries,
		"~/repo",
		{
			onRestore: (e) => calls.restore.push(e),
			onDrop: async (e) => {
				calls.drop.push(e);
				return dropResult;
			},
			onClose: () => calls.close++,
		},
		matcher,
	);
	return { overlay, calls, renders };
}

test("list: down wraps, confirm restores the selected entry", () => {
	const { overlay, calls } = harness([entry("a", "alpha"), entry("b", "beta")]);
	overlay.handleInput("D"); // -> index 1
	overlay.handleInput("E");
	assert.equal(calls.restore.length, 1);
	assert.equal(calls.restore[0]?.id, "b");
});

test("list: cancel closes without restoring", () => {
	const { overlay, calls } = harness([entry("a", "alpha")]);
	overlay.handleInput("X");
	assert.equal(calls.close, 1);
	assert.equal(calls.restore.length, 0);
});

test("detail: space opens, d drops and returns to list, entry is gone", async () => {
	const { overlay, calls } = harness([entry("a", "alpha"), entry("b", "beta")]);
	overlay.handleInput(" "); // open detail on alpha
	let rendered = overlay.render(60);
	assert.ok(
		rendered.some((l) => l.includes("drop")),
		"detail footer shown",
	);

	overlay.handleInput("d"); // drop alpha
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.drop.length, 1);
	assert.equal(calls.drop[0]?.id, "a");

	rendered = overlay.render(60);
	assert.ok(
		rendered.some((l) => l.includes("filter")),
		"back to list footer",
	);
	assert.ok(rendered.some((line) => line.includes("[0]") && line.includes("beta")));

	// alpha is gone; restoring now yields beta
	overlay.handleInput("E");
	assert.equal(calls.restore[0]?.id, "b");
});

test("detail: failed drop keeps the entry visible", async () => {
	const { overlay, calls } = harness([entry("a", "alpha")], false);
	overlay.handleInput(" ");
	overlay.handleInput("d");
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(calls.drop.length, 1);
	assert.ok(overlay.render(60).some((line) => line.includes("alpha")));
});

test("cancel closes once and suppresses callbacks after pending drop settles", async () => {
	let finishDrop: ((value: boolean) => void) | undefined;
	const pendingDrop = new Promise<boolean>((resolve) => {
		finishDrop = resolve;
	});
	const { overlay, calls, renders } = harness([entry("a", "alpha")], pendingDrop);
	overlay.handleInput(" ");
	overlay.handleInput("d");
	const rendersBeforeCancel = renders.length;

	overlay.cancel();
	overlay.cancel();
	overlay.handleInput("E");
	finishDrop?.(true);
	await overlay.settle();

	assert.equal(calls.close, 1);
	assert.equal(calls.restore.length, 0);
	assert.equal(renders.length, rendersBeforeCancel);
});

test("detail: ignores every action while drop is pending", async () => {
	let finishDrop: ((value: boolean) => void) | undefined;
	const pendingDrop = new Promise<boolean>((resolve) => {
		finishDrop = resolve;
	});
	const { overlay, calls } = harness([entry("a", "alpha")], pendingDrop);
	overlay.handleInput(" ");
	overlay.handleInput("d");

	overlay.handleInput("E");
	overlay.handleInput("X");
	overlay.handleInput("d");

	assert.equal(calls.restore.length, 0);
	assert.equal(calls.close, 0);
	assert.equal(calls.drop.length, 1);
	finishDrop?.(true);
	await new Promise((resolve) => setImmediate(resolve));
});

test("detail: cancel returns to list without dropping", () => {
	const { overlay, calls } = harness([entry("a", "alpha")]);
	overlay.handleInput(" ");
	overlay.handleInput("X");
	const rendered = overlay.render(60);
	assert.ok(rendered.some((l) => l.includes("filter")));
	assert.equal(calls.drop.length, 0);
});

test("search filters the list by text", () => {
	const { overlay } = harness([entry("a", "alpha"), entry("b", "beta")]);
	for (const ch of "bet") overlay.handleInput(ch); // type into search
	const rendered = overlay.render(60);
	assert.ok(rendered.some((l) => l.includes("beta")));
	assert.ok(!rendered.some((l) => l.includes("alpha")));
});

test("search with no matches shows the empty state", () => {
	const { overlay } = harness([entry("a", "alpha")]);
	for (const ch of "zzz") overlay.handleInput(ch);
	const rendered = overlay.render(60);
	assert.ok(rendered.some((l) => l.includes("No matching")));
});

test("render draws a framed header and footer", () => {
	const { overlay } = harness([entry("a", "alpha")]);
	const rendered = overlay.render(60);
	assert.ok(rendered.some((l) => l.includes("Stash")));
	assert.ok(rendered.some((l) => l.includes("restore")));
});

test("focus reaches the search input for IME cursor placement", () => {
	const { overlay } = harness([entry("a", "alpha")]);
	overlay.focused = true;
	assert.ok(overlay.render(60).some((line) => line.includes(CURSOR_MARKER)));
});
