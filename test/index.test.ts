import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	doAssetCleanup,
	doClear,
	doDrop,
	doPop,
	doStash,
	drainAssetCleanup,
	installPiStash,
	isSupportedSession,
	openOverlay,
	refreshWidget,
	type StashUi,
} from "../index.ts";
import { removeAssetDir } from "../src/assets.ts";
import { beginAddIntent, beginRestoreIntent } from "../src/intents.ts";
import { resolveStashPaths } from "../src/paths.ts";
import { loadStashStore, STASH_SCHEMA_VERSION } from "../src/store.ts";

const PNG_BYTES = Buffer.from("89504e470d0a1a0a", "hex");
const DEAD_PROCESS_ID = 2_147_483_647;
const UI_OPEN_WAIT_ATTEMPTS = 100;
const UI_OPEN_WAIT_MS = 10;
const STASH_COMMAND_NAMES = [
	"stash",
	"stash-list",
	"stash-pop",
	"stash-drop",
	"stash-cleanup",
	"stash-clear",
] as const;

const directTempImages: string[] = [];

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

type RegisteredCommand = {
	description: string;
	handler(args: unknown, ctx: unknown): unknown;
};

function extensionHarness(): {
	pi: ExtensionAPI;
	handlers: Map<string, ExtensionHandler>;
	commands: Map<string, RegisteredCommand>;
	events: {
		emit(event: string, payload?: unknown): void;
		on(event: string, handler: (payload?: unknown) => void): () => void;
	};
} {
	const handlers = new Map<string, ExtensionHandler>();
	const commands = new Map<string, RegisteredCommand>();
	const eventHandlers = new Map<string, Set<(payload?: unknown) => void>>();
	const events = {
		emit(event: string, payload?: unknown): void {
			eventHandlers.get(event)?.forEach((handler) => {
				handler(payload);
			});
			if (event === "prefix-keybindings:query") this.emit("prefix-keybindings:available");
		},
		on(event: string, handler: (payload?: unknown) => void): () => void {
			const registered = eventHandlers.get(event) ?? new Set();
			registered.add(handler);
			eventHandlers.set(event, registered);
			return () => registered.delete(handler);
		},
	};
	const pi = {
		on(event: string, handler: ExtensionHandler): void {
			handlers.set(event, handler);
		},
		registerCommand(name: string, command: RegisteredCommand): void {
			commands.set(name, command);
		},
		events,
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands, events };
}

type ExtensionHandler = (event: unknown, ctx: unknown) => unknown;

let baseDir: string;

test("isSupportedSession activates only interactive TUI sessions", () => {
	assert.equal(isSupportedSession({ mode: "tui", hasUI: true }), true);
	assert.equal(isSupportedSession({ mode: "rpc", hasUI: true }), false);
	assert.equal(isSupportedSession({ mode: "json", hasUI: false }), false);
	assert.equal(isSupportedSession({ mode: "tui", hasUI: false }), false);
});

beforeEach(() => {
	baseDir = mkdtempSync(path.join(tmpdir(), "pi-stash-index-"));
	directTempImages.length = 0;
});

afterEach(() => {
	rmSync(baseDir, { recursive: true, force: true });
	for (const image of directTempImages) rmSync(image, { force: true });
});

function clipboardImage(): string {
	const image = path.join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
	writeFileSync(image, PNG_BYTES);
	directTempImages.push(image);
	return image;
}

function poisonLockOwner(paths: ReturnType<typeof resolveStashPaths>): void {
	const lockPath = `${paths.stashFile}.lock`;
	const ownerPath = path.join(lockPath, "owner.json");
	const targetPath = `${lockPath}.poison`;
	rmSync(ownerPath, { force: true });
	writeFileSync(targetPath, "not a lock owner");
	symlinkSync(targetPath, ownerPath);
}

function removePoisonedLock(paths: ReturnType<typeof resolveStashPaths>): void {
	rmSync(`${paths.stashFile}.lock`, { recursive: true, force: true });
	rmSync(`${paths.stashFile}.lock.poison`, { force: true });
}

function loadReleaseFailingStore(paths: ReturnType<typeof resolveStashPaths>) {
	return loadStashStore(paths, Date.now, async (filePath, file) => {
		writeFileSync(filePath, JSON.stringify(file));
		poisonLockOwner(paths);
	});
}

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

test("doStash completes committed work when lock release fails", async () => {
	const paths = resolveStashPaths("/stash-unlock-failure", baseDir);
	const store = await loadReleaseFailingStore(paths);
	const ui = fakeUi({ editorText: "committed draft" });

	await doStash(ui, store, paths);
	removePoisonedLock(paths);

	const reopened = await loadStashStore(paths);
	assert.equal(reopened.entryCount, 1);
	assert.equal(reopened.entries[0]?.text, "committed draft");
	assert.equal(ui.editorText, "");
	assert.ok(
		ui.notifs.some((notification) => notification.message.includes("release storage lock")),
	);
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
	const image = clipboardImage();
	const ui = fakeUi({ editorText: `see ${image}` });

	await doStash(ui, store, paths);

	const entry = store.entries[0];
	assert.ok(entry);
	assert.equal(entry.assetCount, 1, "assetCount recorded");
	assert.notEqual(entry.text, `see ${image}`, "path rewritten to persisted copy");
	const assetFile = path.join(paths.assetDir(entry.id), `00-${path.basename(image)}`);
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
	const image = clipboardImage();
	const ui = fakeUi({ editorText: `see ${image}` });

	await assert.rejects(() => doStash(ui, store, paths), /stash data uses schema version/);

	assert.deepEqual(existsSync(paths.assetsRoot) ? readdirSync(paths.assetsRoot) : [], []);
	assert.equal(ui.editorText, `see ${image}`);
});

test("doStash aggregates persistence and staged-asset rollback failures", async () => {
	const paths = resolveStashPaths("/stash-rollback-failure", baseDir);
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
	const image = clipboardImage();
	const ui = fakeUi({ editorText: `see ${image}` });

	await assert.rejects(
		() =>
			doStash(ui, store, paths, undefined, async () => {
				throw new Error("rollback failed");
			}),
		(error: unknown) =>
			error instanceof AggregateError &&
			error.errors.some((nested) => String(nested).includes("stash data uses schema version")) &&
			error.errors.some((nested) => String(nested).includes("rollback failed")),
	);
	assert.equal(ui.editorText, `see ${image}`);
});

test("restashing a restored image transfers ownership for later drop", async () => {
	const paths = resolveStashPaths("/repo", baseDir);
	const store = await loadStashStore(paths);
	const image = clipboardImage();
	const ui = fakeUi({ editorText: `see ${image}` });
	await doStash(ui, store, paths);
	const original = store.entries[0];
	assert.ok(original);
	const originalAssetDir = paths.assetDir(original.id);

	await doPop(ui, store, paths);
	assert.deepEqual(store.restoredAssetLeaseIds, [original.id]);
	let queuedAtRemoval: readonly string[] = [];
	await doStash(ui, store, paths, undefined, async (assetDir) => {
		queuedAtRemoval = [...store.pendingAssetCleanupIds];
		await removeAssetDir(assetDir);
	});
	const transferred = store.entries[0];
	assert.ok(transferred);

	assert.deepEqual(queuedAtRemoval, [original.id]);
	assert.deepEqual(store.restoredAssetLeaseIds, []);
	assert.deepEqual(store.pendingAssetCleanupIds, []);
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

test("doPop keeps a committed restore when lock release fails", async () => {
	const paths = resolveStashPaths("/pop-unlock-failure", baseDir);
	const seed = await loadStashStore(paths);
	await seed.add({ text: "restored draft" });
	const store = await loadReleaseFailingStore(paths);
	const ui = fakeUi();

	await doPop(ui, store, paths);
	removePoisonedLock(paths);

	assert.equal(ui.editorText, "restored draft");
	assert.equal((await loadStashStore(paths)).entryCount, 0);
	assert.ok(
		ui.notifs.some((notification) => notification.message.includes("release storage lock")),
	);
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

test("doPop restores the prior editor when durable removal fails", async () => {
	const paths = resolveStashPaths("/restore-failure", baseDir);
	const writer = await loadStashStore(paths);
	await writer.add({ text: "stashed" });
	const store = await loadStashStore(paths, Date.now, async () => {
		throw new Error("write failed");
	});
	const ui = fakeUi();

	await assert.rejects(() => doPop(ui, store, paths), /write failed/);

	assert.equal(ui.editorText, "");
	assert.equal(store.entryCount, 1);
	assert.equal((await loadStashStore(paths)).entryCount, 1);
});

test("doPop does not overwrite typing entered while a failed removal is pending", async () => {
	const paths = resolveStashPaths("/restore-race", baseDir);
	const writer = await loadStashStore(paths);
	await writer.add({ text: "stashed" });
	let rejectWrite: ((error: Error) => void) | undefined;
	let signalWriteStarted: (() => void) | undefined;
	const writeStarted = new Promise<void>((resolve) => {
		signalWriteStarted = resolve;
	});
	const store = await loadStashStore(
		paths,
		Date.now,
		() =>
			new Promise<void>((_resolve, reject) => {
				rejectWrite = reject;
				signalWriteStarted?.();
			}),
	);
	const ui = fakeUi();

	const popping = doPop(ui, store, paths);
	await writeStarted;
	ui.editorText = "new typing";
	rejectWrite?.(new Error("write failed"));
	await assert.rejects(() => popping, /write failed/);

	assert.equal(ui.editorText, "new typing");
	assert.equal(store.entryCount, 1);
});

test("notifications sanitize untrusted selectors before terminal display", async () => {
	const store = await loadStashStore(resolveStashPaths("/safe-notification", baseDir));
	const paths = resolveStashPaths("/safe-notification", baseDir);
	const ui = fakeUi();

	await doPop(ui, store, paths, "missing\u001b[2J\u202e");

	const notification = ui.notifs.at(-1)?.message ?? "";
	assert.equal(notification.includes("\u001b"), false);
	assert.equal(notification.includes("\u202e"), false);
	assert.ok(notification.includes("missing"));
});

test("doPop warns when selector matches nothing", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const paths = resolveStashPaths("/repo", baseDir);
	const ui = fakeUi();

	await doPop(ui, store, paths, "999");

	assert.ok(ui.notifs.some((n) => n.type === "warning"));
});

test("doAssetCleanup retains editor references and retries failed lease cleanup", async () => {
	const paths = resolveStashPaths("/restored-cleanup", baseDir);
	const store = await loadStashStore(paths);
	const retained = await store.add({ text: "retained", assetCount: 1 });
	const abandoned = await store.add({ text: "abandoned", assetCount: 1 });
	for (const entry of [retained, abandoned]) {
		mkdirSync(paths.assetDir(entry.id), { recursive: true });
		writeFileSync(path.join(paths.assetDir(entry.id), "00-image.png"), "image");
	}
	await store.pop(retained.id);
	await store.pop(abandoned.id);
	const ui = fakeUi({ editorText: `${paths.assetDir(retained.id)}/00-image.png` });

	await doAssetCleanup(ui, store, paths, async (assetDir) => {
		if (assetDir === paths.assetDir(abandoned.id)) throw new Error("remove failed");
		await removeAssetDir(assetDir);
	});

	assert.deepEqual(store.restoredAssetLeaseIds, [retained.id]);
	assert.deepEqual(store.pendingAssetCleanupIds, [abandoned.id]);
	assert.equal(existsSync(paths.assetDir(retained.id)), true);
	assert.equal(existsSync(paths.assetDir(abandoned.id)), true);
	assert.ok(
		ui.notifs.some(({ message }) => message.includes("retained 1") && message.includes("failed 1")),
	);

	ui.editorText = "";
	await doAssetCleanup(ui, store, paths);
	assert.deepEqual(store.restoredAssetLeaseIds, []);
	assert.deepEqual(store.pendingAssetCleanupIds, []);
	assert.equal(existsSync(paths.assetDir(retained.id)), false);
	assert.equal(existsSync(paths.assetDir(abandoned.id)), false);
});

test("doAssetCleanup is repeatable when no restored assets remain", async () => {
	const paths = resolveStashPaths("/empty-cleanup", baseDir);
	const store = await loadStashStore(paths);
	const ui = fakeUi();

	await doAssetCleanup(ui, store, paths);
	await doAssetCleanup(ui, store, paths);

	assert.equal(ui.notifs.at(-1)?.message, "Asset cleanup: deleted 0, retained 0, failed 0");
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

test("doDrop keeps a committed removal when lock release fails", async () => {
	const paths = resolveStashPaths("/drop-unlock-failure", baseDir);
	const seed = await loadStashStore(paths);
	await seed.add({ text: "removed draft" });
	const store = await loadReleaseFailingStore(paths);
	const ui = fakeUi();

	await doDrop(ui, store, paths);
	removePoisonedLock(paths);

	const reopened = await loadStashStore(paths);
	assert.equal(reopened.entryCount, 0);
	assert.equal(reopened.pendingAssetCleanupIds.length, 1);
	assert.ok(
		ui.notifs.some((notification) => notification.message.includes("release storage lock")),
	);
});

test("doDrop keeps failed asset cleanup durable and retries it", async () => {
	const paths = resolveStashPaths("/drop-cleanup", baseDir);
	const store = await loadStashStore(paths);
	const entry = await store.add({ text: "x", assetCount: 1 });
	mkdirSync(paths.assetDir(entry.id), { recursive: true });
	writeFileSync(path.join(paths.assetDir(entry.id), "00-a.png"), "x");
	const ui = fakeUi();
	refreshWidget(ui, store);

	await doDrop(ui, store, paths, undefined, async () => {
		throw new Error("remove failed");
	});

	assert.equal(store.entryCount, 0);
	assert.deepEqual(store.pendingAssetCleanupIds, [entry.id]);
	assert.equal(existsSync(paths.assetDir(entry.id)), true);
	assert.equal(ui.widgets.has("pi-stash"), false);
	assert.ok(ui.notifs.some((notification) => notification.message.includes("failed to remove")));

	await drainAssetCleanup(ui, store, paths, removeAssetDir);
	assert.deepEqual(store.pendingAssetCleanupIds, []);
	assert.equal(existsSync(paths.assetDir(entry.id)), false);
});

test("asset cleanup retries after removal succeeds but acknowledgement fails", async () => {
	const paths = resolveStashPaths("/cleanup-acknowledgement", baseDir);
	const seed = await loadStashStore(paths);
	const entry = await seed.add({ text: "removed", assetCount: 1 });
	mkdirSync(paths.assetDir(entry.id), { recursive: true });
	writeFileSync(path.join(paths.assetDir(entry.id), "00-image.png"), "image");
	await seed.drop(entry.id);
	const failing = await loadStashStore(paths, Date.now, async () => {
		throw new Error("acknowledgement failed");
	});

	await drainAssetCleanup(fakeUi(), failing, paths);

	assert.equal(existsSync(paths.assetDir(entry.id)), false);
	assert.deepEqual((await loadStashStore(paths)).pendingAssetCleanupIds, [entry.id]);
	const recovered = await loadStashStore(paths);
	await drainAssetCleanup(fakeUi(), recovered, paths);
	assert.deepEqual((await loadStashStore(paths)).pendingAssetCleanupIds, []);
});

test("openOverlay resolves when shutdown aborts an open custom UI", async () => {
	const paths = resolveStashPaths("/cancel-overlay", baseDir);
	const store = await loadStashStore(paths);
	await store.add({ text: "stashed" });
	const ui = fakeUi();
	let opened = false;
	ui.custom = (factory) =>
		new Promise((resolve) => {
			opened = true;
			factory({ requestRender: () => {} }, undefined, undefined, resolve);
		});
	const controller = new AbortController();

	const opening = openOverlay(
		{ cwd: "/cancel-overlay", mode: "tui", hasUI: true, ui },
		store,
		paths,
		controller.signal,
	);
	for (let attempt = 0; attempt < UI_OPEN_WAIT_ATTEMPTS && !opened; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, UI_OPEN_WAIT_MS));
	}
	assert.equal(opened, true);
	controller.abort();
	await opening;

	assert.equal(store.entryCount, 1);
});

test("doClear cancellation leaves every draft untouched", async () => {
	const paths = resolveStashPaths("/cancel-clear", baseDir);
	const store = await loadStashStore(paths);
	await store.add({ text: "preserved" });
	const ui = fakeUi();
	ui.confirm = async (_title, _message, options?: { signal?: AbortSignal }) => {
		await new Promise<void>((resolve) => {
			options?.signal?.addEventListener("abort", () => resolve(), { once: true });
		});
		return false;
	};
	const controller = new AbortController();

	const clearing = doClear(ui, store, paths, undefined, controller.signal);
	controller.abort();
	await clearing;

	assert.equal(store.entryCount, 1);
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

test("doClear keeps a committed clear when lock release fails", async () => {
	const paths = resolveStashPaths("/clear-unlock-failure", baseDir);
	const seed = await loadStashStore(paths);
	await seed.add({ text: "removed draft" });
	const store = await loadReleaseFailingStore(paths);
	const ui = fakeUi({ confirmResult: true });

	await doClear(ui, store, paths);
	removePoisonedLock(paths);

	const reopened = await loadStashStore(paths);
	assert.equal(reopened.entryCount, 0);
	assert.equal(reopened.pendingAssetCleanupIds.length, 1);
	assert.ok(
		ui.notifs.some((notification) => notification.message.includes("release storage lock")),
	);
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

test("doClear reports partial asset cleanup and preserves failed work", async () => {
	const paths = resolveStashPaths("/clear-cleanup", baseDir);
	const store = await loadStashStore(paths);
	const failed = await store.add({ text: "failed" });
	const removed = await store.add({ text: "removed" });
	for (const entry of [failed, removed]) {
		mkdirSync(paths.assetDir(entry.id), { recursive: true });
		writeFileSync(path.join(paths.assetDir(entry.id), "00-a.png"), "x");
	}
	const ui = fakeUi({ confirmResult: true });

	await doClear(ui, store, paths, async (assetDir) => {
		if (assetDir === paths.assetDir(failed.id)) throw new Error("remove failed");
		await removeAssetDir(assetDir);
	});

	assert.equal(store.entryCount, 0);
	assert.deepEqual(store.pendingAssetCleanupIds, [failed.id]);
	assert.equal(existsSync(paths.assetDir(failed.id)), true);
	assert.equal(existsSync(paths.assetDir(removed.id)), false);
	assert.ok(ui.notifs.some((notification) => notification.message.includes("failed to remove")));
});

test("drainAssetCleanup keeps a committed acknowledgement when lock release fails", async () => {
	const paths = resolveStashPaths("/cleanup-unlock-failure", baseDir);
	const seed = await loadStashStore(paths);
	const entry = await seed.add({ text: "removed draft", assetCount: 1 });
	mkdirSync(paths.assetDir(entry.id), { recursive: true });
	writeFileSync(path.join(paths.assetDir(entry.id), "00-image.png"), "image");
	await seed.drop(entry.id);
	const store = await loadReleaseFailingStore(paths);
	const ui = fakeUi();

	await drainAssetCleanup(ui, store, paths);
	removePoisonedLock(paths);

	assert.equal(existsSync(paths.assetDir(entry.id)), false);
	assert.deepEqual((await loadStashStore(paths)).pendingAssetCleanupIds, []);
	assert.ok(
		ui.notifs.some((notification) => notification.message.includes("release storage lock")),
	);
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

test("session shutdown cancels prefix operations that have not started", async () => {
	const { pi, handlers, events } = extensionHarness();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = baseDir;
	try {
		installPiStash(pi, { legacyBaseDir: path.join(baseDir, "legacy") });
		const ui = fakeUi();
		const ctx = { cwd: "/queued-repo", mode: "tui", hasUI: true, ui };
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		ui.editorText = "one draft";

		events.emit("pi-stash:stash");
		events.emit("pi-stash:stash");
		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);

		const paths = resolveStashPaths(ctx.cwd, path.join(baseDir, "pi-stash"));
		const store = await loadStashStore(paths);
		assert.equal(store.entryCount, 0);
		assert.equal(ui.widgets.has("pi-stash"), false);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("unsupported schema stays unavailable across startup and every command", async () => {
	const { pi, handlers, commands } = extensionHarness();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = baseDir;
	try {
		const cwd = "/future-schema";
		const legacyBaseDir = path.join(baseDir, "legacy");
		const legacyPaths = resolveStashPaths(cwd, legacyBaseDir);
		await (await loadStashStore(legacyPaths)).add({ text: "legacy stays put" });
		const paths = resolveStashPaths(cwd, path.join(baseDir, "pi-stash"));
		mkdirSync(path.dirname(paths.stashFile), { recursive: true });
		const futureVersion = STASH_SCHEMA_VERSION + 1;
		const original = JSON.stringify({
			schemaVersion: futureVersion,
			cwd: paths.sanitized,
			createdAt: 1,
			updatedAt: 1,
			entries: [],
		});
		writeFileSync(paths.stashFile, original);
		installPiStash(pi, { legacyBaseDir });
		const ui = fakeUi();
		const ctx = { cwd, mode: "tui", hasUI: true, ui };

		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);

		const unavailableReason = ui.notifs.at(-1)?.message ?? "";
		assert.ok(unavailableReason.includes(`schema version ${futureVersion}`));
		assert.ok(
			unavailableReason.includes(`supports schema versions through ${STASH_SCHEMA_VERSION}`),
		);
		assert.ok(unavailableReason.toLowerCase().includes("upgrade"));
		assert.ok(unavailableReason.includes("export"));
		assert.ok(ui.widgets.get("pi-stash")?.some((line) => line.includes("unavailable")));
		for (const name of STASH_COMMAND_NAMES) {
			await commands.get(name)?.handler("0", ctx);
			assert.equal(ui.notifs.at(-1)?.message, unavailableReason, name);
		}
		assert.equal(readFileSync(paths.stashFile, "utf8"), original);
		assert.equal((await loadStashStore(legacyPaths)).entries[0]?.text, "legacy stays put");
		assert.equal(readdirSync(path.dirname(paths.stashFile)).length, 1);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("session startup retries durable asset cleanup", async () => {
	const { pi, handlers } = extensionHarness();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = baseDir;
	try {
		const cwd = "/cleanup-retry";
		const paths = resolveStashPaths(cwd, path.join(baseDir, "pi-stash"));
		const seed = await loadStashStore(paths);
		const entry = await seed.add({ text: "removed", assetCount: 1 });
		mkdirSync(paths.assetDir(entry.id), { recursive: true });
		writeFileSync(path.join(paths.assetDir(entry.id), "00-a.png"), "x");
		await seed.drop(entry.id);

		installPiStash(pi, { legacyBaseDir: path.join(baseDir, "legacy") });
		const ui = fakeUi();
		const ctx = { cwd, mode: "tui", hasUI: true, ui };
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);

		assert.equal(existsSync(paths.assetDir(entry.id)), false);
		assert.deepEqual((await loadStashStore(paths)).pendingAssetCleanupIds, []);
		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("session startup migrates the exact legacy worktree scope", async () => {
	const { pi, handlers } = extensionHarness();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = path.join(baseDir, "configured-agent");
	const legacyBaseDir = path.join(baseDir, "legacy", "pi-stash");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const cwd = "/legacy-migration";
		const legacyPaths = resolveStashPaths(cwd, legacyBaseDir);
		const legacy = await loadStashStore(legacyPaths);
		await legacy.add({ text: "legacy draft" });

		installPiStash(pi, { legacyBaseDir });
		const ui = fakeUi();
		const ctx = { cwd, mode: "tui", hasUI: true, ui };
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);

		const configuredPaths = resolveStashPaths(cwd, path.join(agentDir, "pi-stash"));
		assert.equal((await loadStashStore(configuredPaths)).entries[0]?.text, "legacy draft");
		assert.equal(existsSync(legacyPaths.stashFile), false);
		assert.ok(ui.notifs.some((notification) => notification.message.includes("Migrated")));
		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("session startup reports a legacy migration conflict and stays inactive", async () => {
	const { pi, handlers } = extensionHarness();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = path.join(baseDir, "configured-agent");
	const legacyBaseDir = path.join(baseDir, "legacy", "pi-stash");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const cwd = "/legacy-conflict";
		await (await loadStashStore(resolveStashPaths(cwd, legacyBaseDir))).add({ text: "legacy" });
		await (await loadStashStore(resolveStashPaths(cwd, path.join(agentDir, "pi-stash")))).add({
			text: "configured",
		});

		installPiStash(pi, { legacyBaseDir });
		const ui = fakeUi();
		const ctx = { cwd, mode: "tui", hasUI: true, ui };
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);

		assert.ok(
			ui.notifs.some(
				(notification) =>
					notification.type === "error" && notification.message.includes("destination conflicts"),
			),
		);
		assert.equal(ui.widgets.has("pi-stash"), false);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("session startup reconciles interrupted add and restore mutations", async () => {
	const { pi, handlers } = extensionHarness();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = path.join(baseDir, "configured-agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const cwd = "/intent-recovery";
		const paths = resolveStashPaths(cwd, path.join(agentDir, "pi-stash"));
		const store = await loadStashStore(paths);
		const restored = await store.add({ text: "restore me" });
		const deadOwner = {
			pid: DEAD_PROCESS_ID,
			host: hostname(),
			startedAt: Date.now(),
			token: "dead-session",
		};
		await beginRestoreIntent(paths, restored, deadOwner);
		await store.pop(restored.id);
		const abandonedId = "abandoned-add";
		await beginAddIntent(paths, abandonedId, deadOwner);
		mkdirSync(paths.assetDir(abandonedId), { recursive: true });
		writeFileSync(path.join(paths.assetDir(abandonedId), "00-image.png"), "image");

		installPiStash(pi, { legacyBaseDir: path.join(baseDir, "legacy") });
		const ui = fakeUi();
		const ctx = { cwd, mode: "tui", hasUI: true, ui };
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);

		assert.equal((await loadStashStore(paths)).entries[0]?.text, "restore me");
		assert.equal(existsSync(paths.assetDir(abandonedId)), false);
		assert.ok(ui.notifs.some((notification) => notification.message.includes("Recovered")));
		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});
