import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	doClear,
	doDrop,
	doPop,
	doStash,
	isSupportedSession,
	refreshWidget,
	type StashUi,
} from "../index.ts";
import { resolveStashPaths } from "../src/paths.ts";
import { loadStashStore, STASH_SCHEMA_VERSION } from "../src/store.ts";

type FakeUiOptions = {
	editorText?: string;
	confirmResult?: boolean;
};

function fakeUi(options: FakeUiOptions = {}): StashUi & {
	widgets: Map<string, string[] | undefined>;
	notifs: Array<{ message: string; type?: string }>;
	editorText: string;
} {
	let editorText = options.editorText ?? "";
	const widgets = new Map<string, string[] | undefined>();
	const notifs: Array<{ message: string; type?: string }> = [];
	const confirmResult = options.confirmResult ?? true;
	return {
		notify: (message, type) => notifs.push({ message, type }),
		confirm: async () => confirmResult,
		getEditorText: () => editorText,
		setEditorText: (text) => {
			editorText = text;
		},
		setWidget: (key, content) => {
			if (content === undefined) widgets.delete(key);
			else widgets.set(key, content);
		},
		theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
		custom: async () => undefined,
		widgets,
		notifs,
		get editorText() {
			return editorText;
		},
		set editorText(value: string) {
			editorText = value;
		},
	};
}

let baseDir: string;

test("isSupportedSession activates only interactive TUI sessions", () => {
	assert.equal(isSupportedSession({ mode: "tui", hasUI: true }), true);
	assert.equal(isSupportedSession({ mode: "rpc", hasUI: true }), false);
	assert.equal(isSupportedSession({ mode: "json", hasUI: false }), false);
	assert.equal(isSupportedSession({ mode: "tui", hasUI: false }), false);
});

beforeEach(() => {
	baseDir = mkdtempSync(path.join(tmpdir(), "pi-stash-index-"));
});

afterEach(() => {
	rmSync(baseDir, { recursive: true, force: true });
});

test("doStash persists the draft, clears the editor, and shows the widget", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const paths = resolveStashPaths("/repo", baseDir);
	const ui = fakeUi({ editorText: "finish the report" });

	await doStash(ui, store, paths);

	assert.equal(store.entryCount, 1);
	assert.equal(store.entries[0]?.text, "finish the report");
	assert.equal(ui.editorText, "", "editor cleared after stash");
	assert.ok(ui.widgets.has("pi-stash"), "widget populated");
	assert.ok(ui.notifs.some((n) => n.message.startsWith("Stashed")));
});

test("doStash preserves text typed while persistence is in progress", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const paths = resolveStashPaths("/repo", baseDir);
	const ui = fakeUi({ editorText: "original draft" });

	const stashing = doStash(ui, store, paths);
	ui.editorText = "new typing";
	await stashing;

	assert.equal(store.entries[0]?.text, "original draft");
	assert.equal(ui.editorText, "new typing");
});

test("doStash with nothing typed notifies and writes nothing", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const paths = resolveStashPaths("/repo", baseDir);
	const ui = fakeUi({ editorText: "   " });

	await doStash(ui, store, paths);

	assert.equal(store.entryCount, 0);
	assert.ok(ui.notifs.some((n) => n.message === "Nothing to stash"));
});

test("doStash persists a tmp image and records the assetCount", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const paths = resolveStashPaths("/repo", baseDir);
	// baseDir itself lives under os.tmpdir(), so a file beneath it is treated as
	// a tmp-dir image and persisted by the assets pipeline.
	const tmpRoot = path.join(baseDir, "tmp");
	mkdirSync(tmpRoot, { recursive: true });
	const img = path.join(tmpRoot, "clip.png");
	writeFileSync(img, "png");
	const ui = fakeUi({ editorText: `see ${img}` });

	await doStash(ui, store, paths);

	const entry = store.entries[0];
	assert.ok(entry);
	assert.equal(entry.assetCount, 1, "assetCount recorded");
	assert.notEqual(entry.text, `see ${img}`, "path rewritten to persisted copy");
	const assetFile = path.join(paths.assetDir(entry.id), "00-clip.png");
	assert.ok(entry.text.includes(assetFile), "text points at asset copy");
	assert.ok(existsSync(assetFile), "asset file copied");
});

test("doStash removes staged assets when the store rejects the entry", async () => {
	const paths = resolveStashPaths("/repo", baseDir);
	const store = await loadStashStore(paths);
	writeFileSync(
		paths.stashFile,
		JSON.stringify({
			schemaVersion: STASH_SCHEMA_VERSION + 1,
			cwd: paths.sanitized,
			createdAt: 1,
			updatedAt: 1,
			entries: [],
		}),
	);
	const tmpRoot = path.join(baseDir, "tmp-failed");
	mkdirSync(tmpRoot);
	const image = path.join(tmpRoot, "clip.png");
	writeFileSync(image, "png");
	const ui = fakeUi({ editorText: `see ${image}` });

	await assert.rejects(() => doStash(ui, store, paths), /unsupported stash schema version/);

	assert.deepEqual(existsSync(paths.assetsRoot) ? readdirSync(paths.assetsRoot) : [], []);
	assert.equal(ui.editorText, `see ${image}`);
});

test("restashing a restored image transfers ownership for later drop", async () => {
	const paths = resolveStashPaths("/repo", baseDir);
	const store = await loadStashStore(paths);
	const tmpRoot = path.join(baseDir, "tmp-transfer");
	mkdirSync(tmpRoot);
	const image = path.join(tmpRoot, "clip.png");
	writeFileSync(image, "png");
	const ui = fakeUi({ editorText: `see ${image}` });
	await doStash(ui, store, paths);
	const original = store.entries[0];
	assert.ok(original);
	const originalAssetDir = paths.assetDir(original.id);

	await doPop(ui, store, paths);
	await doStash(ui, store, paths);
	const transferred = store.entries[0];
	assert.ok(transferred);

	assert.equal(existsSync(originalAssetDir), false);
	assert.equal(existsSync(paths.assetDir(transferred.id)), true);
	await doDrop(ui, store, paths);
	assert.equal(existsSync(paths.assetDir(transferred.id)), false);
});

test("doPop restores the newest draft into the editor and removes it", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const paths = resolveStashPaths("/repo", baseDir);
	await store.add({ text: "first" });
	await store.add({ text: "second" });
	const ui = fakeUi();

	await doPop(ui, store, paths);

	assert.equal(ui.editorText, "second");
	assert.equal(store.entryCount, 1);
	assert.equal(store.entries[0]?.text, "first");
	assert.ok(ui.notifs.some((n) => n.message.startsWith("Restored")));
});

test("doPop defaults to the newest draft added by another store", async () => {
	const paths = resolveStashPaths("/repo", baseDir);
	const writer = await loadStashStore(paths);
	await writer.add({ text: "older" });
	const stale = await loadStashStore(paths);
	await writer.add({ text: "newer" });
	const ui = fakeUi();

	await doPop(ui, stale, paths);

	assert.equal(ui.editorText, "newer");
	assert.equal(stale.entries[0]?.text, "older");
});

test("doPop blocks restore when typing begins while stash removal is waiting", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const paths = resolveStashPaths("/repo", baseDir);
	await store.add({ text: "stashed" });
	const ui = fakeUi();

	const popping = doPop(ui, store, paths);
	ui.editorText = `${ui.editorText} plus typing`;
	await popping;

	assert.equal(ui.editorText, " plus typing");
	assert.equal(store.entryCount, 1);
	assert.ok(ui.notifs.some((notification) => notification.type === "warning"));
});

test("doPop preserves a nonempty editor and leaves the stash untouched", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const paths = resolveStashPaths("/repo", baseDir);
	await store.add({ text: "stashed" });
	const ui = fakeUi({ editorText: "current draft" });

	await doPop(ui, store, paths);

	assert.equal(ui.editorText, "current draft");
	assert.equal(store.entryCount, 1);
	assert.ok(ui.notifs.some((notification) => notification.type === "warning"));
});

test("doPop warns when selector matches nothing", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const paths = resolveStashPaths("/repo", baseDir);
	const ui = fakeUi();

	await doPop(ui, store, paths, "999");

	assert.ok(ui.notifs.some((n) => n.type === "warning"));
});

test("doDrop removes the entry and its asset dir", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const paths = resolveStashPaths("/repo", baseDir);
	const entry = await store.add({ text: "x", assetCount: 1 });
	mkdirSync(paths.assetDir(entry.id), { recursive: true });
	writeFileSync(path.join(paths.assetDir(entry.id), "00-a.png"), "x");

	await doDrop(fakeUi(), store, paths);

	assert.equal(store.entryCount, 0);
	assert.equal(existsSync(paths.assetDir(entry.id)), false);
});

test("doClear respects a confirmed dialog and wipes everything", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const paths = resolveStashPaths("/repo", baseDir);
	await store.add({ text: "a" });
	await store.add({ text: "b" });
	const ui = fakeUi({ confirmResult: true });

	await doClear(ui, store, paths);

	assert.equal(store.entryCount, 0);
	assert.equal(ui.widgets.has("pi-stash"), false, "widget cleared");
});

test("doClear sees drafts added by another store after startup", async () => {
	const paths = resolveStashPaths("/repo", baseDir);
	const stale = await loadStashStore(paths);
	const writer = await loadStashStore(paths);
	await writer.add({ text: "added later" });
	const ui = fakeUi({ confirmResult: true });

	await doClear(ui, stale, paths);

	const reopened = await loadStashStore(paths);
	assert.equal(reopened.entryCount, 0);
	assert.ok(ui.notifs.some((notification) => notification.message === "Cleared 1 draft"));
});

test("doClear is a no-op when the user declines", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const paths = resolveStashPaths("/repo", baseDir);
	await store.add({ text: "a" });

	await doClear(fakeUi({ confirmResult: false }), store, paths);

	assert.equal(store.entryCount, 1);
});

test("refreshWidget populates with entries and clears when empty", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const ui = fakeUi();
	refreshWidget(ui, store);
	assert.equal(ui.widgets.has("pi-stash"), false);

	await store.add({ text: "x" });
	refreshWidget(ui, store);
	assert.ok(ui.widgets.has("pi-stash"));
});
