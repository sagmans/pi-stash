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

import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import install from "../index.ts";
import { DEFAULT_LIST_SHORTCUT, DEFAULT_STASH_SHORTCUT } from "../src/config.ts";
import type { ExtensionAPI, StashKeybindings } from "../src/host.ts";
import { installPiStash, isSupportedSession } from "../src/index.ts";
import { beginAddIntent, beginRestoreIntent, reconcileMutationIntents } from "../src/intents.ts";
import {
	doAssetCleanup,
	doClear,
	doDrop,
	doRestore,
	doStash,
	drainAssetCleanup,
	openOverlay,
	refreshWidget,
	type StashUi,
} from "../src/operations.ts";
import type { StashOverlayComponent } from "../src/overlay.ts";
import { resolveLegacyStashPaths, resolveStashPaths } from "../src/paths.ts";
import { removePrivateDirectory as removeAssetDir } from "../src/private-fs.ts";
import { loadStashStore, STASH_SCHEMA_VERSION, writeStashFile } from "../src/store.ts";

const PNG_BYTES = Buffer.from("89504e470d0a1a0a", "hex");
const DEAD_PROCESS_ID = 2_147_483_647;
const CUSTOM_KEY_GLYPHS: Readonly<Record<string, string>> = {
	"tui.select.down": "J",
	"tui.select.confirm": "R",
	"tui.select.cancel": "Q",
};
const CUSTOM_KEY_LABELS: Readonly<Record<string, string>> = {
	"tui.select.up": "k",
	"tui.select.down": "j",
	"tui.select.confirm": "r",
	"tui.select.cancel": "q",
	"tui.input.tab": "p",
	"tui.select.pageUp": "u",
	"tui.select.pageDown": "n",
};
const CUSTOM_KEYBINDINGS = {
	matches: (data: string, action: string) => CUSTOM_KEY_GLYPHS[action] === data,
	getKeys: (action: string) => [CUSTOM_KEY_LABELS[action] ?? action],
} as StashKeybindings;
const STASH_COMMAND_NAMES = [
	"stash",
	"stash-list",
	"stash-restore",
	"stash-pop",
	"stash-drop",
	"stash-cleanup",
	"stash-migrate",
	"stash-clear",
] as const;

const directTempImages: string[] = [];

type FakeUiOptions = {
	editorText?: string;
	confirmResult?: boolean;
	widgetWidth?: number;
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
	const widgetWidth = options.widgetWidth ?? 80;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	return {
		notify: (message, type) => notifs.push({ message, type }),
		confirm: async () => confirmResult,
		getEditorText: () => editorText,
		setEditorText: (text) => {
			editorText = text;
		},
		setWidget: (key, content) => {
			if (content === undefined) {
				widgets.delete(key);
				return;
			}
			const widgetContent = content as unknown;
			if (typeof widgetContent === "function") {
				const component = widgetContent(undefined, theme) as {
					render(width: number): string[];
				};
				widgets.set(key, component.render(widgetWidth));
				return;
			}
			widgets.set(key, content as string[]);
		},
		theme,
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

type RegisteredShortcut = {
	description: string;
	handler(ctx: unknown): unknown;
};

function extensionHarness(): {
	pi: ExtensionAPI;
	handlers: Map<string, ExtensionHandler>;
	commands: Map<string, RegisteredCommand>;
	shortcuts: Map<string, RegisteredShortcut>;
} {
	const handlers = new Map<string, ExtensionHandler>();
	const commands = new Map<string, RegisteredCommand>();
	const shortcuts = new Map<string, RegisteredShortcut>();
	const pi = {
		on(event: string, handler: ExtensionHandler): void {
			handlers.set(event, handler);
		},
		registerCommand(name: string, command: RegisteredCommand): void {
			commands.set(name, command);
		},
		registerShortcut(shortcut: string, definition: RegisteredShortcut): void {
			shortcuts.set(shortcut, definition);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands, shortcuts };
}

type ExtensionHandler = (event: unknown, ctx: unknown) => unknown;

let baseDir: string;
let previousAgentDir: string | undefined;
let previousHome: string | undefined;

test("isSupportedSession activates only interactive TUI sessions", () => {
	assert.equal(isSupportedSession({ mode: "tui", hasUI: true }), true);
	assert.equal(isSupportedSession({ mode: "rpc", hasUI: true }), false);
	assert.equal(isSupportedSession({ mode: "json", hasUI: false }), false);
	assert.equal(isSupportedSession({ mode: "tui", hasUI: false }), false);
	assert.equal(isSupportedSession({ hasUI: true }, true), true, "omp omits the mode field");
	assert.equal(isSupportedSession({ hasUI: false }, true), false);
	assert.equal(
		isSupportedSession({ hasUI: true }, false),
		false,
		"ACP reports hasUI without a real terminal",
	);
});

beforeEach(() => {
	baseDir = mkdtempSync(path.join(tmpdir(), "pi-stash-index-"));
	directTempImages.length = 0;
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	previousHome = process.env.HOME;
	process.env.PI_CODING_AGENT_DIR = baseDir;
	process.env.HOME = baseDir;
});

afterEach(() => {
	rmSync(baseDir, { recursive: true, force: true });
	for (const image of directTempImages) rmSync(image, { force: true });
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
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

function captureOverlay(
	ui: StashUi,
	keybindings: StashKeybindings = getKeybindings(),
): Promise<StashOverlayComponent> {
	return new Promise((opened) => {
		ui.custom = (factory) =>
			new Promise((done) => {
				const overlay = factory({ requestRender: () => {} }, undefined, keybindings, done);
				opened(overlay as StashOverlayComponent);
			});
	});
}

test("doStash persists the draft, clears the editor, and shows the widget", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const paths = resolveStashPaths("/repo", baseDir);
	const ui = fakeUi({ editorText: "finish the report" });

	await doStash({ ui, store, paths });

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

	await doStash({ ui, store, paths });
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

	const stashing = doStash({ ui, store, paths });
	ui.editorText = "new typing";
	await stashing;

	assert.equal(store.entries[0]?.text, "original draft");
	assert.equal(ui.editorText, "new typing");
});

test("doStash with nothing typed notifies and writes nothing", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const paths = resolveStashPaths("/repo", baseDir);
	const ui = fakeUi({ editorText: "   " });

	await doStash({ ui, store, paths });

	assert.equal(store.entryCount, 0);
	assert.ok(ui.notifs.some((n) => n.message === "Nothing to stash"));
});

test("doStash persists a tmp image and records the assetCount", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const paths = resolveStashPaths("/repo", baseDir);
	const image = clipboardImage();
	const ui = fakeUi({ editorText: `see ${image}` });

	await doStash({ ui, store, paths });

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

	await assert.rejects(() => doStash({ ui, store, paths }), /stash data uses schema version/);

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
			doStash({ ui, store, paths }, undefined, async () => {
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
	await doStash({ ui, store, paths });
	const original = store.entries[0];
	assert.ok(original);
	const originalAssetDir = paths.assetDir(original.id);

	await doRestore({ ui, store, paths });
	assert.deepEqual(store.restoredAssetLeaseIds, [original.id]);
	let queuedAtRemoval: readonly string[] = [];
	await doStash({ ui, store, paths }, undefined, async (assetDir) => {
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
	await doDrop({ ui, store, paths });
	assert.equal(existsSync(paths.assetDir(transferred.id)), false);
});

test("doRestore restores the newest draft into the editor and removes it", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const paths = resolveStashPaths("/repo", baseDir);
	await store.add({ text: "first" });
	await store.add({ text: "second" });
	const ui = fakeUi();

	await doRestore({ ui, store, paths });

	assert.equal(ui.editorText, "second");
	assert.equal(store.entryCount, 1);
	assert.equal(store.entries[0]?.text, "first");
	assert.ok(ui.notifs.some((n) => n.message.startsWith("Restored")));
});

test("doRestore keeps a committed restore when lock release fails", async () => {
	const paths = resolveStashPaths("/pop-unlock-failure", baseDir);
	const seed = await loadStashStore(paths);
	await seed.add({ text: "restored draft" });
	const store = await loadReleaseFailingStore(paths);
	const ui = fakeUi();

	await doRestore({ ui, store, paths });
	removePoisonedLock(paths);

	assert.equal(ui.editorText, "restored draft");
	assert.equal((await loadStashStore(paths)).entryCount, 0);
	assert.ok(
		ui.notifs.some((notification) => notification.message.includes("release storage lock")),
	);
});

test("doRestore defaults to the newest draft added by another store", async () => {
	const paths = resolveStashPaths("/repo", baseDir);
	const writer = await loadStashStore(paths);
	await writer.add({ text: "older" });
	const stale = await loadStashStore(paths);
	await writer.add({ text: "newer" });
	const ui = fakeUi();

	await doRestore({ ui, store: stale, paths });

	assert.equal(ui.editorText, "newer");
	assert.equal(stale.entries[0]?.text, "older");
});

test("doRestore blocks restore when typing begins while stash removal is waiting", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const paths = resolveStashPaths("/repo", baseDir);
	await store.add({ text: "stashed" });
	const ui = fakeUi();

	const popping = doRestore({ ui, store, paths });
	ui.editorText = `${ui.editorText} plus typing`;
	await popping;

	assert.equal(ui.editorText, " plus typing");
	assert.equal(store.entryCount, 1);
	assert.ok(ui.notifs.some((notification) => notification.type === "warning"));
});

test("doRestore preserves a nonempty editor and leaves the stash untouched", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const paths = resolveStashPaths("/repo", baseDir);
	await store.add({ text: "stashed" });
	const ui = fakeUi({ editorText: "current draft" });

	await doRestore({ ui, store, paths });

	assert.equal(ui.editorText, "current draft");
	assert.equal(store.entryCount, 1);
	assert.ok(ui.notifs.some((notification) => notification.type === "warning"));
});

test("doRestore restores the prior editor when durable removal fails", async () => {
	const paths = resolveStashPaths("/restore-failure", baseDir);
	const writer = await loadStashStore(paths);
	await writer.add({ text: "stashed" });
	const store = await loadStashStore(paths, Date.now, async () => {
		throw new Error("write failed");
	});
	const ui = fakeUi();

	await assert.rejects(() => doRestore({ ui, store, paths }), /write failed/);

	assert.equal(ui.editorText, "");
	assert.equal(store.entryCount, 1);
	assert.equal((await loadStashStore(paths)).entryCount, 1);
});

test("doRestore does not overwrite typing entered while a failed removal is pending", async () => {
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

	const popping = doRestore({ ui, store, paths });
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

	await doRestore({ ui, store, paths }, "missing\u001b[2J\u202e");

	const notification = ui.notifs.at(-1)?.message ?? "";
	assert.equal(notification.includes("\u001b"), false);
	assert.equal(notification.includes("\u202e"), false);
	assert.ok(notification.includes("missing"));
});

test("doRestore warns when selector matches nothing", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const paths = resolveStashPaths("/repo", baseDir);
	const ui = fakeUi();

	await doRestore({ ui, store, paths }, "999");

	assert.ok(ui.notifs.some((n) => n.type === "warning"));
});

test("doRestore finalizes the restore intent when an abort fires after the durable removal", async () => {
	const paths = resolveStashPaths("/restore-abort", baseDir);
	const seed = await loadStashStore(paths);
	await seed.add({ text: "restore me" });
	const controller = new AbortController();
	// Fire the abort once the pop mutation has durably committed (the stash file
	// now holds zero entries) but before restoreEntry can finalize the intent.
	const store = await loadStashStore(paths, Date.now, async (filePath, file) => {
		const outcome = await writeStashFile(filePath, file);
		if (file.entries.length === 0) controller.abort();
		return outcome;
	});
	const ui = fakeUi();

	await doRestore({ ui, store, paths }, undefined, controller.signal);

	// The restore already took effect durably: the editor holds the draft and the
	// stash no longer lists it.
	assert.equal(ui.editorText, "restore me");
	assert.equal((await loadStashStore(paths)).entryCount, 0);
	// The crash-recovery intent must be finalized rather than abandoned on disk,
	// where a later reconciliation would treat it as an interrupted restore.
	assert.equal(existsSync(`${paths.stashFile}.intents`), false, "restore intent finalized");
	const reconciled = await loadStashStore(paths);
	await reconcileMutationIntents(paths, reconciled);
	assert.equal(reconciled.entryCount, 0, "reconciliation did not resurrect the restored draft");
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

	await doAssetCleanup({ ui, store, paths }, async (assetDir) => {
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
	await doAssetCleanup({ ui, store, paths });
	assert.deepEqual(store.restoredAssetLeaseIds, []);
	assert.deepEqual(store.pendingAssetCleanupIds, []);
	assert.equal(existsSync(paths.assetDir(retained.id)), false);
	assert.equal(existsSync(paths.assetDir(abandoned.id)), false);
});

test("doAssetCleanup is repeatable when no restored assets remain", async () => {
	const paths = resolveStashPaths("/empty-cleanup", baseDir);
	const store = await loadStashStore(paths);
	const ui = fakeUi();

	await doAssetCleanup({ ui, store, paths });
	await doAssetCleanup({ ui, store, paths });

	assert.equal(
		ui.notifs.at(-1)?.message,
		"Asset cleanup: removed 0, retained 0, removal failed 0, acknowledgement failed 0",
	);
});

test("doDrop removes the entry and its asset dir", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const paths = resolveStashPaths("/repo", baseDir);
	const entry = await store.add({ text: "x", assetCount: 1 });
	mkdirSync(paths.assetDir(entry.id), { recursive: true });
	writeFileSync(path.join(paths.assetDir(entry.id), "00-a.png"), "x");

	await doDrop({ ui: fakeUi(), store, paths });

	assert.equal(store.entryCount, 0);
	assert.equal(existsSync(paths.assetDir(entry.id)), false);
});

test("doDrop keeps a committed removal when lock release fails", async () => {
	const paths = resolveStashPaths("/drop-unlock-failure", baseDir);
	const seed = await loadStashStore(paths);
	await seed.add({ text: "removed draft" });
	const store = await loadReleaseFailingStore(paths);
	const ui = fakeUi();

	await doDrop({ ui, store, paths });
	removePoisonedLock(paths);

	const reopened = await loadStashStore(paths);
	assert.equal(reopened.entryCount, 0);
	assert.equal(reopened.pendingAssetCleanupIds.length, 1);
	assert.ok(
		ui.notifs.some((notification) => notification.message.includes("release storage lock")),
	);
});

test("doDrop continues cleanup after a committed directory-sync failure", async () => {
	const paths = resolveStashPaths("/drop-sync-failure", baseDir);
	const seed = await loadStashStore(paths);
	const entry = await seed.add({ text: "removed", assetCount: 1 });
	mkdirSync(paths.assetDir(entry.id), { recursive: true });
	writeFileSync(path.join(paths.assetDir(entry.id), "00-image.png"), "image");
	const store = await loadStashStore(paths, Date.now, (filePath, file) =>
		writeStashFile(filePath, file, async () => {
			throw new Error("sync failed");
		}),
	);
	const ui = fakeUi();

	await doDrop({ ui, store, paths });

	assert.equal(existsSync(paths.assetDir(entry.id)), false);
	assert.deepEqual((await loadStashStore(paths)).pendingAssetCleanupIds, []);
	assert.ok(ui.notifs.some(({ message }) => message.includes("directory sync failed")));
});

test("doDrop keeps failed asset cleanup durable and retries it", async () => {
	const paths = resolveStashPaths("/drop-cleanup", baseDir);
	const store = await loadStashStore(paths);
	const entry = await store.add({ text: "x", assetCount: 1 });
	mkdirSync(paths.assetDir(entry.id), { recursive: true });
	writeFileSync(path.join(paths.assetDir(entry.id), "00-a.png"), "x");
	const ui = fakeUi();
	refreshWidget(ui, store);

	await doDrop({ ui, store, paths }, undefined, async () => {
		throw new Error("remove failed");
	});

	assert.equal(store.entryCount, 0);
	assert.deepEqual(store.pendingAssetCleanupIds, [entry.id]);
	assert.equal(existsSync(paths.assetDir(entry.id)), true);
	assert.equal(ui.widgets.has("pi-stash"), false);
	assert.ok(ui.notifs.some((notification) => notification.message.includes("failed to remove")));

	await drainAssetCleanup({ ui, store, paths }, removeAssetDir);
	assert.deepEqual(store.pendingAssetCleanupIds, []);
	assert.equal(existsSync(paths.assetDir(entry.id)), false);
});

test("asset cleanup waits for stash metadata directory durability before removal", async () => {
	const paths = resolveStashPaths("/cleanup-directory-sync", baseDir);
	const store = await loadStashStore(paths);
	const entry = await store.add({ text: "removed", assetCount: 1 });
	await store.drop(entry.id);
	let removed = false;

	await assert.rejects(
		() =>
			drainAssetCleanup(
				{ ui: fakeUi(), store, paths },
				async () => {
					removed = true;
				},
				"cleanup failed",
				undefined,
				async () => {
					throw new Error("directory sync failed");
				},
			),
		/directory sync failed/u,
	);

	assert.equal(removed, false);
	assert.deepEqual(store.pendingAssetCleanupIds, [entry.id]);
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

	const report = await drainAssetCleanup({ ui: fakeUi(), store: failing, paths });

	assert.deepEqual(report, { removed: 1, removalFailed: 0, acknowledgementFailed: 1 });
	assert.equal(existsSync(paths.assetDir(entry.id)), false);
	assert.deepEqual((await loadStashStore(paths)).pendingAssetCleanupIds, [entry.id]);
	const recovered = await loadStashStore(paths);
	await drainAssetCleanup({ ui: fakeUi(), store: recovered, paths });
	assert.deepEqual((await loadStashStore(paths)).pendingAssetCleanupIds, []);
});

test("openOverlay uses the injected keybindings for actions and footer hints", async () => {
	const paths = resolveStashPaths("/custom-overlay-bindings", baseDir);
	const store = await loadStashStore(paths);
	await store.add({ text: "first" });
	await store.add({ text: "second" });
	const ui = fakeUi();
	const overlayOpened = captureOverlay(ui, CUSTOM_KEYBINDINGS);
	const opening = openOverlay({ cwd: "/custom-overlay-bindings", ui, store, paths });
	const overlay = await overlayOpened;
	assert.ok(overlay.render(160).some((line) => line.includes("kj move")));
	overlay.handleInput("J");
	overlay.handleInput("R");
	await opening;

	assert.equal(ui.editorText, "first");
});

test("openOverlay resolves when shutdown aborts an open custom UI", async () => {
	const paths = resolveStashPaths("/cancel-overlay", baseDir);
	const store = await loadStashStore(paths);
	await store.add({ text: "stashed" });
	const ui = fakeUi();
	const overlayOpened = captureOverlay(ui);
	const controller = new AbortController();

	const opening = openOverlay({ cwd: "/cancel-overlay", ui, store, paths }, controller.signal);
	await overlayOpened;
	controller.abort();
	await opening;

	assert.equal(store.entryCount, 1);
});

test("open overlay refreshes concurrent additions and reports quarantined corruption", async () => {
	const paths = resolveStashPaths("/concurrent-overlay-refresh", baseDir);
	const store = await loadStashStore(paths);
	await store.add({ text: "initial" });
	const writer = await loadStashStore(paths);
	const ui = fakeUi();
	const overlayOpened = captureOverlay(ui);
	const opening = openOverlay({ cwd: "/concurrent-overlay-refresh", ui, store, paths });
	const overlay = await overlayOpened;

	await writer.add({ text: "external addition" });
	overlay.handleInput("\u001b[15~");
	await overlay.settle();
	assert.ok(overlay.render(80).some((line) => line.includes("external addition")));
	assert.ok(ui.widgets.get("pi-stash")?.some((line) => line.includes("external addition")));

	writeFileSync(paths.stashFile, "{ corrupt concurrent state");
	overlay.handleInput("\u001b[15~");
	await overlay.settle();
	assert.ok(ui.notifs.some(({ message }) => message.includes("quarantined for recovery")));
	assert.ok(overlay.render(80).some((line) => line.includes("No matching drafts")));

	overlay.handleInput("\u001b");
	await opening;
});

test("overlay treats an externally removed drop as a benign authoritative refresh", async () => {
	const paths = resolveStashPaths("/concurrent-overlay-drop", baseDir);
	const store = await loadStashStore(paths);
	const stored = await store.add({ text: "removed elsewhere" });
	const writer = await loadStashStore(paths);
	const ui = fakeUi();
	const overlayOpened = captureOverlay(ui);
	const opening = openOverlay({ cwd: "/concurrent-overlay-drop", ui, store, paths });
	const overlay = await overlayOpened;

	await writer.drop(stored.id);
	overlay.handleInput("\t");
	overlay.handleInput("d");
	await overlay.settle();

	assert.ok(ui.notifs.some(({ message }) => message === "Entry already gone"));
	assert.equal(
		ui.notifs.some(({ message }) => message.startsWith("Failed to drop stash entry")),
		false,
	);
	assert.ok(overlay.render(80).some((line) => line.includes("No matching drafts")));
	overlay.handleInput("\u001b");
	await opening;
});

test("overlay preserves rows and reports real lock and mutation failures", async () => {
	const paths = resolveStashPaths("/concurrent-overlay-lock", baseDir);
	const store = await loadStashStore(paths);
	await store.add({ text: "preserved row" });
	const ui = fakeUi();
	const overlayOpened = captureOverlay(ui);
	const opening = openOverlay({ cwd: "/concurrent-overlay-lock", ui, store, paths });
	const overlay = await overlayOpened;
	mkdirSync(`${paths.stashFile}.lock`);
	writeFileSync(path.join(`${paths.stashFile}.lock`, "owner.json"), "placeholder");
	poisonLockOwner(paths);

	overlay.handleInput("\t");
	overlay.handleInput("d");
	await overlay.settle();
	assert.ok(
		ui.notifs.some(
			({ message }) =>
				message.includes("Failed to drop stash entry") && message.includes("symbolic link"),
		),
	);
	overlay.handleInput("\u001b");
	overlay.handleInput("\u001b[15~");
	await overlay.settle();
	assert.ok(
		ui.notifs.some(
			({ message }) =>
				message.includes("Failed to refresh stash") && message.includes("symbolic link"),
		),
	);
	assert.ok(overlay.render(80).some((line) => line.includes("preserved row")));
	overlay.handleInput("\u001b");
	await opening;
	removePoisonedLock(paths);
	assert.equal((await loadStashStore(paths)).entries[0]?.text, "preserved row");
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

	const clearing = doClear({ ui, store, paths }, undefined, controller.signal);
	controller.abort();
	await clearing;

	assert.equal(store.entryCount, 1);
});

test("doClear removes restored-only assets after every draft was restored", async () => {
	const paths = resolveStashPaths("/restored-only-clear", baseDir);
	const store = await loadStashStore(paths);
	const entry = await store.add({ text: "restored", assetCount: 1 });
	mkdirSync(paths.assetDir(entry.id), { recursive: true });
	writeFileSync(path.join(paths.assetDir(entry.id), "00-image.png"), "image");
	await store.pop(entry.id);
	const ui = fakeUi({ confirmResult: true });

	await doClear({ ui, store, paths });

	assert.deepEqual(store.restoredAssetLeaseIds, []);
	assert.deepEqual(store.pendingAssetCleanupIds, []);
	assert.equal(existsSync(paths.assetDir(entry.id)), false);
	assert.ok(ui.notifs.some(({ message }) => message === "Cleared 0 drafts"));
});

test("doClear respects a confirmed dialog and wipes everything", async () => {
	const store = await loadStashStore(resolveStashPaths("/repo", baseDir));
	const paths = resolveStashPaths("/repo", baseDir);
	await store.add({ text: "a" });
	await store.add({ text: "b" });
	const ui = fakeUi({ confirmResult: true });

	await doClear({ ui, store, paths });

	assert.equal(store.entryCount, 0);
	assert.equal(ui.widgets.has("pi-stash"), false, "widget cleared");
});

test("doClear keeps a committed clear when lock release fails", async () => {
	const paths = resolveStashPaths("/clear-unlock-failure", baseDir);
	const seed = await loadStashStore(paths);
	await seed.add({ text: "removed draft" });
	const store = await loadReleaseFailingStore(paths);
	const ui = fakeUi({ confirmResult: true });

	await doClear({ ui, store, paths });
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

	await doClear({ ui, store: stale, paths });

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

	await doClear({ ui, store, paths }, async (assetDir) => {
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

	await drainAssetCleanup({ ui, store, paths });
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

	await doClear({ ui: fakeUi({ confirmResult: false }), store, paths });

	assert.equal(store.entryCount, 1);
});

test("refreshWidget warns once when a committed schema upgrade cannot sync", async () => {
	const paths = resolveStashPaths("/upgrade-sync-warning", baseDir);
	mkdirSync(path.dirname(paths.stashFile), { recursive: true });
	writeFileSync(
		paths.stashFile,
		JSON.stringify({
			schemaVersion: 1,
			cwd: paths.sanitized,
			createdAt: 1,
			updatedAt: 2,
			entries: [{ id: "legacy-entry", text: "preserved", createdAt: 1 }],
		}),
	);
	const store = await loadStashStore(paths, Date.now, async (filePath, file) => {
		await writeStashFile(filePath, file);
		return { committed: true, phase: "directory-sync", error: new Error("sync failed") };
	});
	const ui = fakeUi();

	refreshWidget(ui, store);
	refreshWidget(ui, store);

	const warnings = ui.notifs.filter(({ message }) => message.includes("directory sync failed"));
	assert.equal(warnings.length, 1, "durability warning must surface exactly once");
	assert.match(warnings[0]?.message ?? "", /sync failed/u);
});

test("default native shortcuts dispatch stash and list actions", async () => {
	const { pi, handlers, shortcuts } = extensionHarness();
	installPiStash(pi, { legacyBaseDir: path.join(baseDir, "legacy") });
	assert.deepEqual([...shortcuts.keys()], [DEFAULT_STASH_SHORTCUT, DEFAULT_LIST_SHORTCUT]);

	const cwd = "/default-native-shortcuts";
	const ui = fakeUi({ editorText: "draft from editor" });
	let listOpened = 0;
	ui.custom = async () => {
		listOpened += 1;
		return undefined;
	};
	const ctx = { cwd, mode: "tui", hasUI: true, ui };
	await handlers.get("session_start")?.({}, ctx);
	await shortcuts.get(DEFAULT_STASH_SHORTCUT)?.handler(ctx);

	const paths = resolveStashPaths(cwd, path.join(baseDir, "pi-stash"));
	assert.equal((await loadStashStore(paths)).entries[0]?.text, "draft from editor");
	assert.equal(ui.editorText, "");
	await shortcuts.get(DEFAULT_LIST_SHORTCUT)?.handler(ctx);
	assert.equal(listOpened, 1);
	await handlers.get("session_shutdown")?.({}, ctx);
});

test("custom native shortcuts dispatch stash and list actions", async () => {
	const configDir = path.join(baseDir, "pi-stash");
	mkdirSync(configDir);
	writeFileSync(
		path.join(configDir, "config.json"),
		JSON.stringify({ keybindings: { stash: "alt+s", list: "alt+l" } }),
	);
	const { pi, handlers, shortcuts } = extensionHarness();
	await install(pi);
	assert.deepEqual([...shortcuts.keys()], ["alt+s", "alt+l"]);

	const cwd = "/custom-native-shortcuts";
	const ui = fakeUi({ editorText: "custom shortcut draft" });
	let listOpened = 0;
	ui.custom = async () => {
		listOpened += 1;
		return undefined;
	};
	const ctx = { cwd, mode: "tui", hasUI: true, ui };
	await handlers.get("session_start")?.({}, ctx);
	await shortcuts.get("alt+s")?.handler(ctx);
	await shortcuts.get("alt+l")?.handler(ctx);

	const paths = resolveStashPaths(cwd, configDir);
	assert.equal((await loadStashStore(paths)).entries[0]?.text, "custom shortcut draft");
	assert.equal(ui.editorText, "");
	assert.equal(listOpened, 1);
	await handlers.get("session_shutdown")?.({}, ctx);
});

test("extension reload reapplies changed shortcut config", async () => {
	const configDir = path.join(baseDir, "pi-stash");
	mkdirSync(configDir);
	const configPath = path.join(configDir, "config.json");
	writeFileSync(configPath, JSON.stringify({ keybindings: { stash: "alt+s", list: "alt+l" } }));
	const first = extensionHarness();
	await install(first.pi);

	writeFileSync(configPath, JSON.stringify({ keybindings: { stash: "ctrl+a", list: "ctrl+b" } }));
	const reloaded = extensionHarness();
	await install(reloaded.pi);

	assert.deepEqual([...first.shortcuts.keys()], ["alt+s", "alt+l"]);
	assert.deepEqual([...reloaded.shortcuts.keys()], ["ctrl+a", "ctrl+b"]);
});

test("invalid config fails before partial extension registration", async () => {
	const configDir = path.join(baseDir, "pi-stash");
	mkdirSync(configDir);
	writeFileSync(path.join(configDir, "config.json"), "{ malformed");
	const { pi, handlers, commands, shortcuts } = extensionHarness();

	await assert.rejects(() => install(pi), /invalid pi-stash config/iu);
	assert.equal(handlers.size, 0);
	assert.equal(commands.size, 0);
	assert.equal(shortcuts.size, 0);
});

test("slash stash persists its argument without reading or clearing the editor", async () => {
	const { pi, handlers, commands } = extensionHarness();
	installPiStash(pi, { legacyBaseDir: path.join(baseDir, "legacy") });
	const cwd = "/slash-draft";
	const ui = fakeUi({ editorText: "unrelated editor text" });
	const ctx = { cwd, mode: "tui", hasUI: true, ui };
	await handlers.get("session_start")?.({}, ctx);

	await commands.get("stash")?.handler("draft from argument", ctx);
	const paths = resolveStashPaths(cwd, path.join(baseDir, "pi-stash"));
	assert.equal((await loadStashStore(paths)).entries[0]?.text, "draft from argument");
	assert.equal(ui.editorText, "unrelated editor text");

	await commands.get("stash")?.handler("  spaced draft  ", ctx);
	assert.equal((await loadStashStore(paths)).entries[0]?.text, "  spaced draft  ");
	assert.equal(ui.editorText, "unrelated editor text");

	await commands.get("stash")?.handler(undefined, ctx);
	await commands.get("stash")?.handler(" \t ", ctx);
	assert.equal((await loadStashStore(paths)).entryCount, 2);
	assert.equal(ui.editorText, "unrelated editor text");
	assert.deepEqual(ui.notifs.at(-1), {
		message: "Usage: /stash <draft>",
		type: "warning",
	});
	await handlers.get("session_shutdown")?.({}, ctx);
});

test("registered commands execute the documented stash workflows", async () => {
	const { pi, handlers, commands } = extensionHarness();
	await install(pi);
	assert.deepEqual([...commands.keys()], [...STASH_COMMAND_NAMES]);
	const ui = fakeUi({ editorText: "unrelated editor draft" });
	let listOpened = 0;
	ui.custom = async () => {
		listOpened += 1;
		return undefined;
	};
	const ctx = { cwd: "/command-contract", mode: "tui", hasUI: true, ui };
	const paths = resolveStashPaths(ctx.cwd, path.join(baseDir, "pi-stash"));
	await handlers.get("session_start")?.({ type: "session_start" }, ctx);

	await commands.get("stash")?.handler("saved through command", ctx);
	assert.equal(ui.editorText, "unrelated editor draft");
	assert.equal((await loadStashStore(paths)).entries[0]?.text, "saved through command");
	await commands.get("stash-list")?.handler("", ctx);
	assert.equal(listOpened, 1);

	await commands.get("stash-restore")?.handler("0", ctx);
	assert.equal(ui.editorText, "unrelated editor draft");
	assert.ok(ui.notifs.some(({ message }) => message.includes("Clear or stash")));
	ui.editorText = "";
	await commands.get("stash-restore")?.handler("0", ctx);
	assert.equal(ui.editorText, "saved through command");
	assert.equal((await loadStashStore(paths)).entryCount, 0);

	ui.editorText = "";
	await commands.get("stash")?.handler("pop through command", ctx);
	await commands.get("stash-pop")?.handler("", ctx);
	assert.equal(ui.editorText, "pop through command");
	assert.equal((await loadStashStore(paths)).entryCount, 0);
	await commands.get("stash-pop")?.handler("", ctx);
	assert.ok(ui.notifs.at(-1)?.message.includes("No stashed drafts"));

	ui.editorText = "";
	await commands.get("stash")?.handler("drop through command", ctx);
	await commands.get("stash-drop")?.handler("missing", ctx);
	assert.ok(ui.notifs.at(-1)?.message.includes('No stash entry matching "missing"'));
	await commands.get("stash-drop")?.handler("0", ctx);
	assert.equal((await loadStashStore(paths)).entryCount, 0);
	await commands.get("stash-cleanup")?.handler("", ctx);
	assert.equal(
		ui.notifs.at(-1)?.message,
		"Asset cleanup: removed 0, retained 0, removal failed 0, acknowledgement failed 0",
	);

	await commands.get("stash")?.handler("clear through command", ctx);
	await commands.get("stash-clear")?.handler("", ctx);
	assert.equal((await loadStashStore(paths)).entryCount, 0);

	await commands.get("stash")?.handler("migrate through command", ctx);
	await commands.get("stash-migrate")?.handler("", ctx);
	assert.ok(ui.notifs.at(-1)?.message.startsWith("Stash migration: migrated"));
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
});

test("command help states selectors, editor prerequisites, and destructive effects", () => {
	const { pi, commands } = extensionHarness();
	installPiStash(pi);

	assert.match(commands.get("stash")?.description ?? "", /draft supplied.*without changing/iu);
	assert.match(commands.get("stash-list")?.description ?? "", /search.*empty editor/iu);
	assert.match(commands.get("stash-restore")?.description ?? "", /index-or-id.*empty editor/iu);
	assert.match(commands.get("stash-pop")?.description ?? "", /newest.*editor/iu);
	assert.match(commands.get("stash-drop")?.description ?? "", /permanently.*index-or-id/iu);
	assert.match(commands.get("stash-cleanup")?.description ?? "", /unreferenced.*images/iu);
	assert.match(commands.get("stash-migrate")?.description ?? "", /legacy.*quarantin/iu);
	assert.match(commands.get("stash-clear")?.description ?? "", /confirm.*every/iu);
});

test("omp-shaped sessions without a mode field execute stash commands", async () => {
	const { pi, handlers, commands } = extensionHarness();
	installPiStash(pi, { isTerminal: true, legacyBaseDir: path.join(baseDir, "legacy") });
	const ui = fakeUi({ editorText: "unrelated omp editor draft" });
	// omp's ExtensionContext exposes cwd/hasUI/ui but omits the mode field.
	const ctx = { cwd: "/omp-contract", hasUI: true, ui };
	const paths = resolveStashPaths(ctx.cwd, path.join(baseDir, "pi-stash"));
	await handlers.get("session_start")?.({ type: "session_start" }, ctx);

	await commands.get("stash")?.handler("omp draft", ctx);
	assert.equal(ui.editorText, "unrelated omp editor draft");
	assert.equal((await loadStashStore(paths)).entries[0]?.text, "omp draft");

	ui.editorText = "";
	await commands.get("stash-restore")?.handler("", ctx);
	assert.equal(ui.editorText, "omp draft");
	assert.equal((await loadStashStore(paths)).entryCount, 0);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
});

test("mode-less sessions without a terminal reject destructive commands", async () => {
	const { pi, handlers, commands } = extensionHarness();
	installPiStash(pi, { isTerminal: false });
	const ui = fakeUi({ editorText: "acp draft" });
	// ACP reports hasUI with a stubbed editor: session_start must not activate.
	const ctx = { cwd: "/acp-contract", hasUI: true, ui };
	const paths = resolveStashPaths(ctx.cwd, path.join(baseDir, "pi-stash"));
	await handlers.get("session_start")?.({ type: "session_start" }, ctx);

	await commands.get("stash")?.handler("", ctx);

	assert.equal(ui.editorText, "acp draft", "no command may touch the editor");
	assert.ok(ui.notifs.some(({ message }) => message.includes("not ready")));
	assert.equal(existsSync(paths.stashFile), false, "no storage may be created");
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

test("refreshWidget renders every row within the current terminal width", async () => {
	const store = await loadStashStore(resolveStashPaths("/narrow-widget", baseDir));
	await store.add({ text: `${"界".repeat(30)} 🧑🏽‍💻` });
	const width = 12;
	const ui = fakeUi({ widgetWidth: width });

	refreshWidget(ui, store);

	assert.equal(
		ui.widgets.get("pi-stash")?.some((line) => visibleWidth(line) > width),
		false,
	);
});

test("session startup shows the configured list shortcut in the stash widget", async () => {
	const { pi, handlers } = extensionHarness();
	const cwd = "/binding-hint";
	const paths = resolveStashPaths(cwd, path.join(baseDir, "pi-stash"));
	await (await loadStashStore(paths)).add({ text: "saved draft" });
	installPiStash(pi, { legacyBaseDir: path.join(baseDir, "legacy") });
	const ui = fakeUi();
	const ctx = { cwd, mode: "tui", hasUI: true, ui };

	await handlers.get("session_start")?.({ type: "session_start" }, ctx);

	assert.ok(ui.widgets.get("pi-stash")?.[0]?.includes("ctrl+shift+r to open"));
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
});

test("duplicate extension instances expose one native handler per shortcut", async () => {
	const { pi, handlers, shortcuts } = extensionHarness();
	installPiStash(pi, { legacyBaseDir: path.join(baseDir, "legacy-one") });
	const firstStart = handlers.get("session_start");
	const firstShutdown = handlers.get("session_shutdown");
	installPiStash(pi, { legacyBaseDir: path.join(baseDir, "legacy-two") });
	const secondStart = handlers.get("session_start");
	const secondShutdown = handlers.get("session_shutdown");
	const ui = fakeUi({ editorText: "stash once" });
	const ctx = { cwd: "/duplicate-extension", mode: "tui", hasUI: true, ui };
	await firstStart?.({ type: "session_start" }, ctx);
	await secondStart?.({ type: "session_start" }, ctx);

	assert.equal(shortcuts.size, 2);
	await shortcuts.get(DEFAULT_STASH_SHORTCUT)?.handler(ctx);
	await firstShutdown?.({ type: "session_shutdown" }, ctx);
	await secondShutdown?.({ type: "session_shutdown" }, ctx);

	const paths = resolveStashPaths(ctx.cwd, path.join(baseDir, "pi-stash"));
	assert.equal((await loadStashStore(paths)).entryCount, 1);
});

test("session replacement isolates queued work and widgets across worktrees", async () => {
	const { pi, handlers, shortcuts } = extensionHarness();
	installPiStash(pi, { legacyBaseDir: path.join(baseDir, "legacy") });
	const firstUi = fakeUi({ editorText: "first worktree draft" });
	const firstContext = { cwd: "/first-worktree", mode: "tui", hasUI: true, ui: firstUi };
	await handlers.get("session_start")?.({}, firstContext);

	const firstStash = shortcuts.get(DEFAULT_STASH_SHORTCUT)?.handler(firstContext);
	const secondUi = fakeUi({ editorText: "second worktree draft" });
	const secondContext = { cwd: "/second-worktree", mode: "tui", hasUI: true, ui: secondUi };
	await handlers.get("session_start")?.({}, secondContext);
	await firstStash;

	assert.equal(firstUi.widgets.has("pi-stash"), false);
	await shortcuts.get(DEFAULT_STASH_SHORTCUT)?.handler(secondContext);
	const stashRoot = path.join(baseDir, "pi-stash");
	assert.equal(
		(await loadStashStore(resolveStashPaths(firstContext.cwd, stashRoot))).entryCount,
		0,
	);
	assert.equal(
		(await loadStashStore(resolveStashPaths(secondContext.cwd, stashRoot))).entries[0]?.text,
		"second worktree draft",
	);
	await handlers.get("session_shutdown")?.({}, secondContext);
});

test("session shutdown cancels native shortcut operations that have not started", async () => {
	const { pi, handlers, shortcuts } = extensionHarness();
	installPiStash(pi, { legacyBaseDir: path.join(baseDir, "legacy") });
	const ui = fakeUi({ editorText: "one draft" });
	const ctx = { cwd: "/queued-repo", mode: "tui", hasUI: true, ui };
	await handlers.get("session_start")?.({ type: "session_start" }, ctx);

	void shortcuts.get(DEFAULT_STASH_SHORTCUT)?.handler(ctx);
	void shortcuts.get(DEFAULT_STASH_SHORTCUT)?.handler(ctx);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);

	const paths = resolveStashPaths(ctx.cwd, path.join(baseDir, "pi-stash"));
	const store = await loadStashStore(paths);
	assert.equal(store.entryCount, 0);
	assert.equal(ui.widgets.has("pi-stash"), false);
});

test("unsupported schema stays unavailable across startup and every command", async () => {
	const { pi, handlers, commands } = extensionHarness();
	{
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
			// The migration sweep deliberately runs from an unavailable session
			// and would change the trailing notification.
			if (name === "stash-migrate") continue;
			await commands.get(name)?.handler("0", ctx);
			assert.equal(ui.notifs.at(-1)?.message, unavailableReason, name);
		}
		assert.equal(readFileSync(paths.stashFile, "utf8"), original);
		assert.equal((await loadStashStore(legacyPaths)).entries[0]?.text, "legacy stays put");
		assert.equal(readdirSync(path.dirname(paths.stashFile)).length, 1);
	}
});

test("startup surfaces a migration conflict with file paths and removal guidance", async () => {
	const { pi, handlers } = extensionHarness();
	installPiStash(pi, { legacyBaseDir: path.join(baseDir, "pi-stash") });
	const ui = fakeUi();
	const ctx = { cwd: "/conflict-scope", mode: "tui", hasUI: true, ui };
	const base = path.join(baseDir, "pi-stash");
	const destination = resolveStashPaths(ctx.cwd, base);
	const legacy = resolveLegacyStashPaths(ctx.cwd, base);
	mkdirSync(base, { recursive: true });
	const currentFile = {
		schemaVersion: STASH_SCHEMA_VERSION,
		cwd: destination.sanitized,
		createdAt: 1,
		updatedAt: 1,
		entries: [{ id: "current-entry", text: "current draft", createdAt: 1 }],
		restoredAssetLeases: [],
		pendingAssetCleanup: [],
	};
	writeFileSync(destination.stashFile, JSON.stringify(currentFile), { mode: 0o600 });
	writeFileSync(
		legacy.stashFile,
		JSON.stringify({
			schemaVersion: STASH_SCHEMA_VERSION,
			cwd: legacy.sanitized,
			createdAt: 1,
			updatedAt: 1,
			entries: [{ id: "legacy-entry", text: "legacy draft", createdAt: 1 }],
			restoredAssetLeases: [],
			pendingAssetCleanup: [],
		}),
		{ mode: 0o600 },
	);

	await handlers.get("session_start")?.({ type: "session_start" }, ctx);

	const reason = ui.notifs.at(-1)?.message ?? "";
	assert.ok(reason.includes("pi-stash unavailable"), reason);
	assert.ok(reason.includes(legacy.stashFile), reason);
	assert.ok(reason.includes(destination.stashFile), reason);
	assert.match(reason, /remove/i);
	assert.match(reason, /reload/i);
	assert.equal(readFileSync(destination.stashFile, "utf8"), JSON.stringify(currentFile));
	assert.equal(existsSync(legacy.stashFile), true);
});

test("startup hints /stash-migrate when any legacy scope conflicts", async () => {
	const { pi, handlers } = extensionHarness();
	const legacyBaseDir = path.join(baseDir, "legacy");
	installPiStash(pi, { legacyBaseDir });
	const conflicted = resolveLegacyStashPaths("/conflicted/scope", legacyBaseDir);
	mkdirSync(legacyBaseDir, { recursive: true });
	writeFileSync(
		conflicted.stashFile,
		JSON.stringify({
			schemaVersion: STASH_SCHEMA_VERSION,
			cwd: conflicted.sanitized,
			createdAt: 1,
			updatedAt: 1,
			entries: [],
			restoredAssetLeases: [],
			pendingAssetCleanup: [],
		}),
		{ mode: 0o600 },
	);
	const destination = resolveStashPaths("/conflicted/scope", path.join(baseDir, "pi-stash"));
	mkdirSync(path.dirname(destination.stashFile), { recursive: true });
	writeFileSync(
		destination.stashFile,
		JSON.stringify({
			schemaVersion: STASH_SCHEMA_VERSION,
			cwd: destination.sanitized,
			createdAt: 1,
			updatedAt: 1,
			entries: [],
			restoredAssetLeases: [],
			pendingAssetCleanup: [],
		}),
		{ mode: 0o600 },
	);

	const ui = fakeUi();
	const ctx = { cwd: "/clean/scope", mode: "tui", hasUI: true, ui };
	await handlers.get("session_start")?.({ type: "session_start" }, ctx);

	const hint = ui.notifs.find(({ message }) => message.includes("/stash-migrate"));
	assert.ok(hint, JSON.stringify(ui.notifs));
	assert.match(hint?.message ?? "", /1 legacy stash conflict/);
});

test("an unavailable session runs /stash-migrate to quarantine its own conflict", async () => {
	const { pi, handlers, commands } = extensionHarness();
	const legacyBaseDir = path.join(baseDir, "legacy");
	installPiStash(pi, { legacyBaseDir });
	const ui = fakeUi();
	const ctx = { cwd: "/conflict-scope", mode: "tui", hasUI: true, ui };
	const legacy = resolveLegacyStashPaths(ctx.cwd, legacyBaseDir);
	mkdirSync(legacyBaseDir, { recursive: true });
	writeFileSync(
		legacy.stashFile,
		JSON.stringify({
			schemaVersion: STASH_SCHEMA_VERSION,
			cwd: legacy.sanitized,
			createdAt: 1,
			updatedAt: 1,
			entries: [],
			restoredAssetLeases: [],
			pendingAssetCleanup: [],
		}),
		{ mode: 0o600 },
	);
	const destination = resolveStashPaths(ctx.cwd, path.join(baseDir, "pi-stash"));
	mkdirSync(path.dirname(destination.stashFile), { recursive: true });
	writeFileSync(
		destination.stashFile,
		JSON.stringify({
			schemaVersion: STASH_SCHEMA_VERSION,
			cwd: destination.sanitized,
			createdAt: 1,
			updatedAt: 1,
			entries: [],
			restoredAssetLeases: [],
			pendingAssetCleanup: [],
		}),
		{ mode: 0o600 },
	);

	await handlers.get("session_start")?.({ type: "session_start" }, ctx);
	assert.ok(
		ui.notifs.at(-1)?.message?.includes("destination conflicts") ?? false,
		ui.notifs.at(-1)?.message ?? "",
	);

	await commands.get("stash-migrate")?.handler("", ctx);

	assert.equal(existsSync(legacy.stashFile), false);
	assert.equal(existsSync(`${legacy.stashFile}.migrate-conflict`), true);
	assert.equal(existsSync(destination.stashFile), true);
	assert.ok(ui.notifs.some(({ message }) => message.includes("quarantined 1 legacy conflicts")));
	assert.ok(
		ui.notifs.at(-1)?.message?.includes("/reload") ?? false,
		ui.notifs.at(-1)?.message ?? "",
	);
	// Other commands remain blocked until the user restarts or reloads.
	await commands.get("stash")?.handler("blocked", ctx);
	assert.ok(ui.notifs.at(-1)?.message?.includes("destination conflicts") ?? false);
});

test("an unsupported session cannot leak the previous scope's unavailable reason", async () => {
	const { pi, handlers, commands } = extensionHarness();
	const unavailableCwd = "/future-then-unsupported";
	const paths = resolveStashPaths(unavailableCwd, path.join(baseDir, "pi-stash"));
	mkdirSync(path.dirname(paths.stashFile), { recursive: true });
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
	installPiStash(pi, { legacyBaseDir: path.join(baseDir, "legacy") });
	const unavailableUi = fakeUi();
	await handlers.get("session_start")?.(
		{},
		{
			cwd: unavailableCwd,
			mode: "tui",
			hasUI: true,
			ui: unavailableUi,
		},
	);
	assert.ok(unavailableUi.notifs.at(-1)?.message.includes("schema version"));

	const unsupportedUi = fakeUi({ editorText: "untouched" });
	const unsupportedContext = {
		cwd: "/rpc-session",
		mode: "rpc",
		hasUI: true,
		ui: unsupportedUi,
	};
	await handlers.get("session_start")?.({}, unsupportedContext);
	await commands.get("stash")?.handler("", unsupportedContext);

	assert.equal(unsupportedUi.editorText, "untouched");
	assert.equal(unsupportedUi.notifs.at(-1)?.message, "pi-stash is not ready yet");
});

test("session startup retries durable asset cleanup", async () => {
	const { pi, handlers } = extensionHarness();
	{
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
	}
});

test("session startup migrates the exact legacy worktree scope", async () => {
	const { pi, handlers } = extensionHarness();
	const agentDir = path.join(baseDir, "configured-agent");
	const legacyBaseDir = path.join(baseDir, "legacy", "pi-stash");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	{
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
	}
});

test("session startup reports a legacy migration conflict and stays inactive", async () => {
	const { pi, handlers } = extensionHarness();
	const agentDir = path.join(baseDir, "configured-agent");
	const legacyBaseDir = path.join(baseDir, "legacy", "pi-stash");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	{
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
	}
});

test("session startup reconciles interrupted add and restore mutations", async () => {
	const { pi, handlers } = extensionHarness();
	const agentDir = path.join(baseDir, "configured-agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	{
		const cwd = "/intent-recovery";
		const paths = resolveStashPaths(cwd, path.join(agentDir, "pi-stash"));
		const store = await loadStashStore(paths);
		const restored = await store.add({ text: "restore me" });
		const deadOwner = {
			pid: DEAD_PROCESS_ID,
			host: hostname(),
			startedAt: Date.now(),
			token: "dead-session",
			generation: "dead-generation",
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
	}
});
