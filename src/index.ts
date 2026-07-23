// pi-stash — stash the current editor draft to disk so it can be resumed later.
//
// Drafts are persisted per worktree under ~/.pi/agent/pi-stash/<sanitized-cwd>.json.
// Trigger surface:
//   prefix+s        stash the current draft (clears the editor)
//   prefix+shift+s  open the stash overlay (↑↓ move · Enter restore · →/space preview · d drop)
//   /stash [msg]    stash with an optional label
//   /stash-list     open the stash list overlay
//   /stash-pop [i]  restore entry i (or the newest) into the editor and remove it
//   /stash-drop [i] delete entry i (or the newest) and its persisted images
//   /stash-clear    delete every stashed draft (confirms first)
//
// Stashed entries also render as a widget above the editor, mirroring how queued
// steering/follow-up messages appear. Tmp-dir image paths are copied into the
// stash so a restored draft never dangles; repo/absolute paths are left live.

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

import { persistTmpImages, removeAssetDir } from "./assets.ts";
import { StashOverlayComponent } from "./overlay.ts";
import { resolveStashPaths } from "./paths.ts";
import { type Claim, startStashBinding } from "./prefix.ts";
import { loadStashStore, type StashStore } from "./store.ts";
import { createNewId, type ResolvedEntry, type StashEntry } from "./types.ts";
import { themedWidgetLines } from "./widget.ts";

const STASH_WIDGET_KEY = "pi-stash";
const STASH_ACTION_EVENT = "pi-stash:stash";
const LIST_ACTION_EVENT = "pi-stash:list";
const RESTORE_BLOCKED_MESSAGE = "Clear or stash the current editor draft before restoring";
const DROP_FAILED_MESSAGE = "Failed to drop stash entry";
const ASSET_CLEANUP_FAILED_MESSAGE = "Dropped draft, but failed to remove persisted images";
const ASSET_TRANSFER_CLEANUP_FAILED_MESSAGE =
	"Stashed draft, but failed to remove older persisted images";

// Narrow UI surface the orchestration needs. The real ExtensionContext.ui
// satisfies this structurally; tests pass a minimal fake.
export type StashUi = {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	confirm(title: string, message: string): Promise<boolean>;
	getEditorText(): string;
	setEditorText(text: string): void;
	setWidget(key: string, content: string[] | undefined): void;
	theme: Pick<Theme, "fg" | "bold">;
	custom<T>(
		factory: (
			tui: StashOverlayTui,
			theme: unknown,
			keybindings: unknown,
			done: (value: T | undefined) => void,
		) => unknown,
		options?: { overlay?: boolean; overlayOptions?: unknown },
	): Promise<T | undefined>;
};

// Slice of TUI that StashOverlay reads. Kept narrow so tests can fake it.
export type StashOverlayTui = {
	requestRender(): void;
};

export type StashSession = {
	cwd: string;
	mode: string;
	hasUI: boolean;
	ui: StashUi;
};

export function isSupportedSession(session: Pick<StashSession, "mode" | "hasUI">): boolean {
	return session.mode === "tui" && session.hasUI;
}

export function refreshWidget(ui: StashUi, store: StashStore): void {
	ui.setWidget(
		STASH_WIDGET_KEY,
		store.entries.length > 0 ? themedWidgetLines(store.entries, ui.theme) : undefined,
	);
}

export async function doStash(
	ui: StashUi,
	store: StashStore,
	paths: ReturnType<typeof resolveStashPaths>,
	message?: string,
): Promise<void> {
	const text = ui.getEditorText();
	if (text.trim().length === 0) {
		ui.notify("Nothing to stash", "info");
		return;
	}

	const id = createNewId();
	const assetDir = paths.assetDir(id);
	const {
		text: persistedText,
		count,
		transferredAssetDirs,
	} = await persistTmpImages({
		text,
		assetDir,
		ownedAssetsRoot: paths.assetsRoot,
	});
	try {
		await store.add({
			id,
			text: persistedText,
			message,
			assetCount: count > 0 ? count : undefined,
		});
	} catch (error) {
		await removeAssetDir(assetDir);
		throw error;
	}
	if (ui.getEditorText() === text) {
		ui.setEditorText("");
		const cleanup = await Promise.allSettled(transferredAssetDirs.map(removeAssetDir));
		if (cleanup.some((result) => result.status === "rejected")) {
			ui.notify(ASSET_TRANSFER_CLEANUP_FAILED_MESSAGE, "error");
		}
	}
	refreshWidget(ui, store);
	ui.notify(
		count > 0 ? `Stashed [0] · ${count} image${count > 1 ? "s" : ""} persisted` : "Stashed [0]",
		"info",
	);
}

export async function openOverlay(
	session: StashSession,
	store: StashStore,
	paths: ReturnType<typeof resolveStashPaths>,
): Promise<void> {
	await store.refresh();
	if (session.mode !== "tui") {
		// No custom UI in headless modes; fall back to a textual summary.
		const entries = store.entries;
		if (entries.length === 0) {
			session.ui.notify("No stashed drafts", "info");
			return;
		}
		session.ui.notify(
			`${entries.length} stashed draft(s). Use /stash-pop <index> to restore.`,
			"info",
		);
		return;
	}

	const entries = [...store.entries];
	if (entries.length === 0) {
		session.ui.notify("No stashed drafts", "info");
		return;
	}

	const cwdLabel = shortCwd(session.cwd);
	const chosen = await session.ui.custom<StashEntry | undefined>(
		(tui, _theme, _kb, done) => {
			return new StashOverlayComponent(tui, session.ui.theme, entries, cwdLabel, {
				onRestore: (entry) => done(entry),
				onClose: () => done(undefined),
				onDrop: async (entry) => {
					let dropped: ResolvedEntry | undefined;
					try {
						dropped = await store.drop(entry.id);
					} catch {
						session.ui.notify(DROP_FAILED_MESSAGE, "error");
						return false;
					}
					if (!dropped) {
						session.ui.notify("Entry already gone", "warning");
						return false;
					}
					try {
						await removeAssetDir(paths.assetDir(entry.id));
					} catch {
						session.ui.notify(ASSET_CLEANUP_FAILED_MESSAGE, "error");
					}
					refreshWidget(session.ui, store);
					session.ui.notify(`Dropped [${dropped.index}]`, "info");
					return true;
				},
			});
		},
		{ overlay: true, overlayOptions: { width: "70%", maxHeight: "80%" } },
	);

	if (!chosen) return;
	await restoreEntry(session.ui, store, chosen.id, "Stash entry vanished before restore");
}

// Compact cwd label for the overlay header: collapse $HOME to ~ and tail the
// last three segments when deep, so the panel stays narrow on long worktree paths.
function shortCwd(cwd: string): string {
	const home = process.env.HOME;
	const display = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
	const segments = display.split("/").filter(Boolean);
	if (segments.length <= 3) return display;
	return `…/${segments.slice(-3).join("/")}`;
}

function editorIsReadyForRestore(ui: StashUi): boolean {
	if (ui.getEditorText().trim().length === 0) return true;
	ui.notify(RESTORE_BLOCKED_MESSAGE, "warning");
	return false;
}

async function restoreEntry(
	ui: StashUi,
	store: StashStore,
	selector: string | undefined,
	missingMessage: string,
): Promise<void> {
	let editorBlocked = false;
	const resolved = await store.pop(selector, (candidate) => {
		if (!editorIsReadyForRestore(ui)) {
			editorBlocked = true;
			return false;
		}
		// This callback runs synchronously inside the store lock after its fresh
		// read, leaving no await where new typing could be overwritten.
		ui.setEditorText(candidate.entry.text);
		return true;
	});
	if (editorBlocked) return;
	if (!resolved) {
		ui.notify(missingMessage, "warning");
		return;
	}
	refreshWidget(ui, store);
	// Assets are intentionally kept: the restored text references them.
	ui.notify(`Restored [${resolved.index}]`, "info");
}

export async function doPop(
	ui: StashUi,
	store: StashStore,
	_paths: ReturnType<typeof resolveStashPaths>,
	selector?: string,
): Promise<void> {
	await restoreEntry(
		ui,
		store,
		selector,
		selector ? `No stash entry matching "${selector}"` : "No stashed drafts",
	);
}

export async function doDrop(
	ui: StashUi,
	store: StashStore,
	paths: ReturnType<typeof resolveStashPaths>,
	selector?: string,
): Promise<void> {
	const resolved = await store.drop(selector);
	if (!resolved) {
		ui.notify(selector ? `No stash entry matching "${selector}"` : "No stashed drafts", "warning");
		return;
	}
	await removeAssetDir(paths.assetDir(resolved.entry.id));
	refreshWidget(ui, store);
	ui.notify(`Dropped [${resolved.index}]`, "info");
}

export async function doClear(
	ui: StashUi,
	store: StashStore,
	paths: ReturnType<typeof resolveStashPaths>,
): Promise<void> {
	await store.refresh();
	if (store.entryCount === 0) {
		ui.notify("No stashed drafts", "info");
		return;
	}
	const ok = await ui.confirm("Clear stash?", "Delete every stashed draft for this worktree?");
	if (!ok) return;
	const ids = await store.clear();
	await Promise.all(ids.map((id) => removeAssetDir(paths.assetDir(id))));
	refreshWidget(ui, store);
	ui.notify(`Cleared ${ids.length} draft${ids.length === 1 ? "" : "s"}`, "info");
}

type ActiveSession = {
	ui: StashUi;
	store: StashStore;
	paths: ReturnType<typeof resolveStashPaths>;
	stopBinding: () => void;
};

type SessionCtx = { cwd: string; mode: string; hasUI: boolean };
type ActiveGetter = () => ActiveSession | undefined;
type ActiveResolver = (ctx: { ui: unknown } | undefined) => ActiveSession | undefined;

/** Trim a single-string command arg; undefined when absent or blank. */
function parseArg(args: unknown): string | undefined {
	return typeof args === "string" && args.trim().length > 0 ? args.trim() : undefined;
}

/** Guard for command handlers: warns and returns nothing before session_start. */
function makeRequireActive(getter: ActiveGetter): ActiveResolver {
	return (ctx) => {
		const active = getter();
		if (!active) {
			if (ctx && "ui" in ctx && ctx.ui && typeof (ctx.ui as StashUi).notify === "function") {
				(ctx.ui as StashUi).notify("pi-stash is not ready yet", "warning");
			}
			return undefined;
		}
		return active;
	};
}

/** Slash commands. Each resolves the active session, then delegates. */
function registerStashCommands(pi: ExtensionAPI, resolve: ActiveResolver): void {
	pi.registerCommand("stash", {
		description: "Stash the current editor draft (prefix+s)",
		handler: async (args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await doStash(session.ui, session.store, session.paths, parseArg(args));
		},
	});
	pi.registerCommand("stash-list", {
		description: "Open the stash list (prefix+shift+s)",
		handler: async (_args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await openOverlay(
				{ cwd: ctx.cwd, mode: ctx.mode, hasUI: ctx.hasUI, ui: session.ui },
				session.store,
				session.paths,
			);
		},
	});
	pi.registerCommand("stash-pop", {
		description: "Restore a stashed draft into the editor and remove it (default: newest)",
		handler: async (args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await doPop(session.ui, session.store, session.paths, parseArg(args));
		},
	});
	pi.registerCommand("stash-drop", {
		description: "Delete a stashed draft and its persisted images (default: newest)",
		handler: async (args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await doDrop(session.ui, session.store, session.paths, parseArg(args));
		},
	});
	pi.registerCommand("stash-clear", {
		description: "Delete every stashed draft for this worktree",
		handler: async (_args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await doClear(session.ui, session.store, session.paths);
		},
	});
}

/** prefix-keybindings claims: `s` stashes, `shift+s` opens the overlay. */
function buildStashClaims(ctx: SessionCtx, getter: ActiveGetter): Claim[] {
	return [
		{ key: "s", eventId: STASH_ACTION_EVENT, onFire: () => fireStash(getter) },
		{ key: "S", eventId: LIST_ACTION_EVENT, onFire: () => fireList(getter, ctx) },
	];
}

function reportActionFailure(ui: StashUi, action: string, operation: Promise<void>): void {
	void operation.catch(() => {
		ui.notify(`pi-stash: ${action} failed`, "error");
	});
}

function fireStash(getter: ActiveGetter): void {
	const active = getter();
	if (active)
		reportActionFailure(active.ui, "stash", doStash(active.ui, active.store, active.paths));
}

function fireList(getter: ActiveGetter, ctx: SessionCtx): void {
	const active = getter();
	if (!active) return;
	reportActionFailure(
		active.ui,
		"open stash list",
		openOverlay(
			{ cwd: ctx.cwd, mode: ctx.mode, hasUI: ctx.hasUI, ui: active.ui },
			active.store,
			active.paths,
		),
	);
}

export function installPiStash(pi: ExtensionAPI): void {
	let active: ActiveSession | undefined;
	const requireActiveForCommand = makeRequireActive(() => active);

	pi.on("session_start", async (_event, ctx) => {
		if (!isSupportedSession(ctx)) return;

		const paths = resolveStashPaths(ctx.cwd);
		const store = await loadStashStore(paths);
		refreshWidget(ctx.ui as StashUi, store);

		const stopBinding = startStashBinding({
			events: pi.events,
			claims: buildStashClaims(ctx, () => active),
			onInert: () => {
				ctx.ui.notify(
					"pi-stash: prefix-keybindings not detected; use /stash and /stash-list",
					"warning",
				);
			},
		});

		active = { ui: ctx.ui as StashUi, store, paths, stopBinding };
	});

	pi.on("session_shutdown", () => {
		active?.stopBinding();
		// Clear the widget so a follow-up session in the same process does not
		// show a stale list belonging to the previous worktree.
		active?.ui.setWidget(STASH_WIDGET_KEY, undefined);
		active = undefined;
	});

	registerStashCommands(pi, requireActiveForCommand);
}

export default function install(pi: ExtensionAPI): void {
	installPiStash(pi);
}
