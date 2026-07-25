import { strict as assert } from "node:assert";
import test from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";

import {
	defaultKeyMatcher,
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
const ANSI_STYLE_PATTERN = /\u001b\[[0-9;]*m/gu;

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
	"tui.select.pageUp": "P",
	"tui.select.pageDown": "N",
	"tui.select.confirm": "E",
	"tui.select.cancel": "X",
	"tui.input.tab": "T",
};
const matcher: KeyMatcher = (data, action) => KEY_GLYPH[action] === data;

type Calls = { restore: StashEntry[]; drop: StashEntry[]; close: number; errors: unknown[] };
function harness(
	entries: StashEntry[],
	dropResult: boolean | Promise<boolean> = true,
	keyMatcher: KeyMatcher = matcher,
	refresh?: () => Promise<readonly StashEntry[]>,
) {
	const calls: Calls = { restore: [], drop: [], close: 0, errors: [] };
	const renders: number[] = [];
	let currentEntries = [...entries];
	const refreshEntries = refresh ?? (async () => currentEntries);
	const overlay = new StashOverlayComponent(
		{ requestRender: () => renders.push(renders.length) },
		theme,
		entries,
		"~/repo",
		{
			onRestore: (e) => calls.restore.push(e),
			onDrop: async (e) => {
				calls.drop.push(e);
				const dropped = await dropResult;
				if (dropped) currentEntries = currentEntries.filter((candidate) => candidate.id !== e.id);
				return dropped;
			},
			onRefresh: refreshEntries,
			onRefreshError: (error) => calls.errors.push(error),
			onClose: () => calls.close++,
		},
		keyMatcher,
	);
	return { overlay, calls, renders };
}

function renderedText(overlay: StashOverlayComponent): string {
	return overlay.render(80).join("\n").replace(ANSI_STYLE_PATTERN, "");
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

test("detail: configured preview key opens, d drops and returns to list, entry is gone", async () => {
	const { overlay, calls } = harness([entry("a", "alpha"), entry("b", "beta")]);
	overlay.handleInput("T"); // open detail on alpha
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
	overlay.handleInput("T");
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
	overlay.handleInput("T");
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
	overlay.handleInput("T");
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
	overlay.handleInput("T");
	overlay.handleInput("X");
	const rendered = overlay.render(60);
	assert.ok(rendered.some((l) => l.includes("filter")));
	assert.equal(calls.drop.length, 0);
});

test("detail preview scroll reaches both bounds while context and controls stay visible", () => {
	const draft = Array.from(
		{ length: 30 },
		(_, index) => `line-${String(index).padStart(2, "0")}`,
	).join("\n");
	const { overlay } = harness([entry("long-entry", draft)]);
	overlay.handleInput("T");

	let rendered = renderedText(overlay);
	assert.ok(rendered.includes("line-00"));
	assert.equal(rendered.includes("line-29"), false);
	assert.ok(rendered.includes("[0] preview"));
	assert.ok(rendered.includes("scroll"));
	assert.ok(rendered.includes("d drop"));

	for (let index = 0; index < 40; index += 1) overlay.handleInput("D");
	rendered = renderedText(overlay);
	assert.equal(rendered.includes("line-00"), false);
	assert.ok(rendered.includes("line-29"));
	assert.ok(rendered.includes("[0] preview"));
	assert.ok(rendered.includes("d drop"));

	overlay.handleInput("\u001b[H");
	assert.ok(renderedText(overlay).includes("line-00"));
	overlay.handleInput("\u001b[F");
	assert.ok(renderedText(overlay).includes("line-29"));
});

test("detail preview handles empty and single-line drafts", () => {
	for (const [text, expected] of [
		["", "(empty draft)"],
		["one line", "one line"],
	] as const) {
		const { overlay } = harness([entry("entry", text)]);
		overlay.handleInput("T");
		assert.ok(renderedText(overlay).includes(expected));
	}
});

test("detail preview keeps wide Unicode within columns and bottom reachable after resize", () => {
	const draft = `${"界".repeat(24)}\n${Array.from({ length: 20 }, (_, index) => `row-${index}`).join("\n")}\nLAST`;
	const { overlay } = harness([entry("wide", draft)]);
	overlay.handleInput("T");
	overlay.handleInput("\u001b[F");

	const wide = overlay.render(50);
	const narrow = overlay.render(18);

	assert.ok(wide.some((line) => line.includes("LAST")));
	assert.ok(narrow.some((line) => line.includes("LAST")));
	assert.equal(
		narrow.some((line) => visibleWidth(line) > 18),
		false,
	);
});

test("detail scrolling is independent from list selection", () => {
	const { overlay, calls } = harness([
		entry("first", "short"),
		entry("second", Array.from({ length: 20 }, (_, index) => `second-${index}`).join("\n")),
	]);
	overlay.handleInput("D");
	overlay.handleInput("T");
	overlay.handleInput("N");
	overlay.handleInput("X");
	overlay.handleInput("E");

	assert.equal(calls.restore[0]?.id, "second");
});

test("refresh replaces rows while preserving selected identity and preview", async () => {
	const initial = [entry("first", "first old"), entry("second", "second old")];
	const refreshed = [entry("new", "new external"), entry("second", "second updated")];
	const { overlay, calls } = harness(initial, true, matcher, async () => refreshed);
	overlay.handleInput("D");
	overlay.handleInput("T");
	overlay.handleInput("\u001b[15~");
	await overlay.settle();

	const preview = renderedText(overlay);
	assert.ok(preview.includes("second updated"));
	assert.equal(preview.includes("first old"), false);
	overlay.handleInput("X");
	overlay.handleInput("E");
	assert.equal(calls.restore[0]?.id, "second");
});

test("newest concurrent refresh wins when an older read completes later", async () => {
	const resolvers: Array<(entries: readonly StashEntry[]) => void> = [];
	const refresh = () =>
		new Promise<readonly StashEntry[]>((resolve) => {
			resolvers.push(resolve);
		});
	const { overlay } = harness([entry("initial", "initial")], true, matcher, refresh);
	overlay.handleInput("\u001b[15~");
	overlay.handleInput("\u001b[15~");
	resolvers[1]?.([entry("newer", "newer snapshot")]);
	await new Promise((resolve) => setImmediate(resolve));
	resolvers[0]?.([entry("older", "older snapshot")]);
	await overlay.settle();

	const rendered = renderedText(overlay);
	assert.ok(rendered.includes("newer snapshot"));
	assert.equal(rendered.includes("older snapshot"), false);
});

test("refresh removal exits a vanished preview and real failures stay visible", async () => {
	let fail = false;
	const { overlay, calls } = harness([entry("gone", "gone")], true, matcher, async () => {
		if (fail) throw new Error("lock unavailable");
		return [];
	});
	overlay.handleInput("T");
	overlay.handleInput("\u001b[15~");
	await overlay.settle();
	assert.ok(renderedText(overlay).includes("No matching drafts"));

	fail = true;
	overlay.handleInput("\u001b[15~");
	await overlay.settle();
	assert.equal(calls.errors.length, 1);
	assert.match(String(calls.errors[0]), /lock unavailable/);
});

test("search filters the list by text", () => {
	const { overlay } = harness([entry("a", "alpha"), entry("b", "beta")]);
	for (const ch of "bet") overlay.handleInput(ch); // type into search
	const rendered = overlay.render(60);
	assert.ok(rendered.some((l) => l.includes("beta")));
	assert.ok(!rendered.some((l) => l.includes("alpha")));
});

test("search with no matches shows the query and cannot restore a hidden entry", () => {
	const { overlay, calls } = harness([entry("a", "alpha")]);
	for (const ch of "zzz") overlay.handleInput(ch);
	overlay.handleInput("E");
	const rendered = renderedText(overlay);
	assert.ok(rendered.includes("> zzz"));
	assert.ok(rendered.includes("No matching"));
	assert.equal(calls.restore.length, 0);
});

test("query edits support spaces, cursor movement, deletion, clearing, paste, and Unicode", () => {
	const { overlay } = harness([entry("target", "alpha beta 日本語"), entry("other", "unrelated")]);
	for (const ch of "alpha  beta") overlay.handleInput(ch);
	overlay.handleInput("\u001b[1;5D");
	overlay.handleInput("\u007f");
	assert.ok(renderedText(overlay).includes("> alpha beta"));
	assert.ok(renderedText(overlay).includes("alpha beta 日本語"));

	overlay.handleInput("\u0005");
	overlay.handleInput("\u0015");
	overlay.handleInput("\u001b[200~日本\u001b[201~");
	assert.ok(renderedText(overlay).includes("> 日本"));
	assert.ok(renderedText(overlay).includes("alpha beta 日本語"));
});

test("every query change resets selection to the first visible result", () => {
	const { overlay, calls } = harness([
		entry("alpha", "match alpha"),
		entry("beta", "other beta"),
		entry("gamma", "match gamma"),
	]);
	overlay.handleInput("D");
	for (const ch of "match") overlay.handleInput(ch);
	overlay.handleInput("E");

	assert.equal(calls.restore[0]?.id, "alpha");
});

test("duplicate labels retain identity under legacy, Kitty, and injected navigation", () => {
	for (const [down, confirm, keyMatcher] of [
		["\u001b[B", "\r", defaultKeyMatcher],
		["\u001b[1;1B", "\u001b[13u", defaultKeyMatcher],
		["D", "E", matcher],
	] as const) {
		const { overlay, calls } = harness(
			[entry("first", "same label"), entry("second", "same label")],
			true,
			keyMatcher,
		);
		overlay.handleInput(down);
		overlay.handleInput(confirm);
		assert.equal(calls.restore[0]?.id, "second");
	}
});

test("Kitty printable input filters and configured preview never mutates in list mode", () => {
	const { overlay, calls } = harness([entry("alpha", "alpha"), entry("beta", "beta")]);
	for (const codepoint of [98, 101, 116, 97]) overlay.handleInput(`\u001b[${codepoint}u`);
	overlay.handleInput("d");

	assert.ok(renderedText(overlay).includes("> betad"));
	assert.equal(calls.drop.length, 0);
	overlay.handleInput("\u0015");
	overlay.handleInput("T");
	assert.ok(renderedText(overlay).includes("preview"));
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
