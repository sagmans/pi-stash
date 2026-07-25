// pi-stash — stash the current editor draft to disk so it can be resumed later.
//
// Drafts are persisted per worktree under <Pi agent dir>/pi-stash/<sanitized-cwd>.json.
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

import path from "node:path";

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

import { persistTmpImages, removeAssetDir } from "./assets.ts";
import { legacyStashBaseDir, migrateLegacyStash } from "./migrate.ts";
import { StashOverlayComponent } from "./overlay.ts";
import { defaultStashBaseDir, resolveStashPaths } from "./paths.ts";
import { type Claim, startStashBinding } from "./prefix.ts";
import { CommittedMutationError, loadStashStore, type StashStore } from "./store.ts";
import { createNewId, type ResolvedEntry, type StashEntry } from "./types.ts";
import { themedWidgetLines } from "./widget.ts";

const STASH_WIDGET_KEY = "pi-stash";
const STASH_ACTION_EVENT = "pi-stash:stash";
const LIST_ACTION_EVENT = "pi-stash:list";
const RESTORE_BLOCKED_MESSAGE = "Clear or stash the current editor draft before restoring";
const DROP_FAILED_MESSAGE = "Failed to drop stash entry";
const ASSET_CLEANUP_FAILED_MESSAGE = "Draft removed, but failed to remove persisted images";
const ASSET_TRANSFER_CLEANUP_FAILED_MESSAGE =
	"Stashed draft, but failed to remove older persisted images";
const LOCK_RELEASE_FAILED_MESSAGE = "failed to release storage lock";
const ROLLBACK_FAILED_MESSAGE = "stash persistence and staged-asset rollback both failed";

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

export type AssetDirRemover = (assetDir: string) => Promise<void>;

function committedMutation<Result>(error: unknown): CommittedMutationError<Result> | undefined {
	return error instanceof CommittedMutationError ? error : undefined;
}

export async function drainAssetCleanup(
	ui: StashUi,
	store: StashStore,
	paths: ReturnType<typeof resolveStashPaths>,
	remove: AssetDirRemover = removeAssetDir,
	failureMessage = ASSET_CLEANUP_FAILED_MESSAGE,
): Promise<void> {
	let failed = false;
	let lockReleaseFailed = false;
	for (const id of [...store.pendingAssetCleanupIds]) {
		try {
			await remove(paths.assetDir(id));
			await store.completeAssetCleanup(id);
		} catch (error) {
			if (committedMutation(error)) lockReleaseFailed = true;
			else failed = true;
		}
	}
	if (failed) ui.notify(failureMessage, "error");
	if (lockReleaseFailed) {
		ui.notify(`Asset cleanup committed, but ${LOCK_RELEASE_FAILED_MESSAGE}`, "error");
	}
}

export async function doStash(
	ui: StashUi,
	store: StashStore,
	paths: ReturnType<typeof resolveStashPaths>,
	message?: string,
	remove: AssetDirRemover = removeAssetDir,
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
	let lockReleaseFailed = false;
	try {
		await store.add({
			id,
			text: persistedText,
			message,
			assetCount: count > 0 ? count : undefined,
			cleanupIds: transferredAssetDirs.map((directory) => path.basename(directory)),
		});
	} catch (error) {
		if (committedMutation(error)) lockReleaseFailed = true;
		else {
			try {
				await remove(assetDir);
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], ROLLBACK_FAILED_MESSAGE);
			}
			throw error;
		}
	}
	if (ui.getEditorText() === text) ui.setEditorText("");
	if (!lockReleaseFailed) {
		await drainAssetCleanup(ui, store, paths, remove, ASSET_TRANSFER_CLEANUP_FAILED_MESSAGE);
	}
	refreshWidget(ui, store);
	const successMessage =
		count > 0 ? `Stashed [0] · ${count} image${count > 1 ? "s" : ""} persisted` : "Stashed [0]";
	ui.notify(
		lockReleaseFailed ? `${successMessage}, but ${LOCK_RELEASE_FAILED_MESSAGE}` : successMessage,
		lockReleaseFailed ? "error" : "info",
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
					refreshWidget(session.ui, store);
					await drainAssetCleanup(session.ui, store, paths);
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
	let restoredText: string | undefined;
	const priorText = ui.getEditorText();
	let resolved: ResolvedEntry | undefined;
	let lockReleaseFailed = false;
	try {
		resolved = await store.pop(selector, (candidate) => {
			if (!editorIsReadyForRestore(ui)) {
				editorBlocked = true;
				return false;
			}
			// This callback runs synchronously inside the store lock after its fresh
			// read, leaving no await where new typing could be overwritten.
			restoredText = candidate.entry.text;
			ui.setEditorText(restoredText);
			return true;
		});
	} catch (error) {
		const committed = committedMutation<ResolvedEntry | undefined>(error);
		if (committed) {
			resolved = committed.result;
			lockReleaseFailed = true;
		} else {
			// The editor is not transactional. Roll it back only when the user has not
			// typed since the candidate was shown while the durable write was pending.
			if (restoredText !== undefined && ui.getEditorText() === restoredText) {
				ui.setEditorText(priorText);
			}
			throw error;
		}
	}
	if (editorBlocked) return;
	if (!resolved) {
		ui.notify(missingMessage, "warning");
		return;
	}
	refreshWidget(ui, store);
	// Assets are intentionally kept: the restored text references them.
	const successMessage = `Restored [${resolved.index}]`;
	ui.notify(
		lockReleaseFailed ? `${successMessage}, but ${LOCK_RELEASE_FAILED_MESSAGE}` : successMessage,
		lockReleaseFailed ? "error" : "info",
	);
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
	remove: AssetDirRemover = removeAssetDir,
): Promise<void> {
	let resolved: ResolvedEntry | undefined;
	let lockReleaseFailed = false;
	try {
		resolved = await store.drop(selector);
	} catch (error) {
		const committed = committedMutation<ResolvedEntry | undefined>(error);
		if (!committed) throw error;
		resolved = committed.result;
		lockReleaseFailed = true;
	}
	if (!resolved) {
		ui.notify(selector ? `No stash entry matching "${selector}"` : "No stashed drafts", "warning");
		return;
	}
	refreshWidget(ui, store);
	if (!lockReleaseFailed) await drainAssetCleanup(ui, store, paths, remove);
	const successMessage = `Dropped [${resolved.index}]`;
	ui.notify(
		lockReleaseFailed ? `${successMessage}, but ${LOCK_RELEASE_FAILED_MESSAGE}` : successMessage,
		lockReleaseFailed ? "error" : "info",
	);
}

export async function doClear(
	ui: StashUi,
	store: StashStore,
	paths: ReturnType<typeof resolveStashPaths>,
	remove: AssetDirRemover = removeAssetDir,
): Promise<void> {
	await store.refresh();
	if (store.entryCount === 0) {
		ui.notify("No stashed drafts", "info");
		return;
	}
	const ok = await ui.confirm("Clear stash?", "Delete every stashed draft for this worktree?");
	if (!ok) return;
	let ids: string[];
	let lockReleaseFailed = false;
	try {
		ids = await store.clear();
	} catch (error) {
		const committed = committedMutation<string[]>(error);
		if (!committed) throw error;
		ids = committed.result;
		lockReleaseFailed = true;
	}
	refreshWidget(ui, store);
	if (!lockReleaseFailed) await drainAssetCleanup(ui, store, paths, remove);
	const successMessage = `Cleared ${ids.length} draft${ids.length === 1 ? "" : "s"}`;
	ui.notify(
		lockReleaseFailed ? `${successMessage}, but ${LOCK_RELEASE_FAILED_MESSAGE}` : successMessage,
		lockReleaseFailed ? "error" : "info",
	);
}

type ActiveSession = {
	ui: StashUi;
	store: StashStore;
	paths: ReturnType<typeof resolveStashPaths>;
	stopBinding: () => void;
	accepting: boolean;
	pending: Promise<void>;
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
		if (!active?.accepting) {
			if (ctx && "ui" in ctx && ctx.ui && typeof (ctx.ui as StashUi).notify === "function") {
				(ctx.ui as StashUi).notify("pi-stash is not ready yet", "warning");
			}
			return undefined;
		}
		return active;
	};
}

function enqueueOperation(active: ActiveSession, operation: () => Promise<void>): Promise<void> {
	if (!active.accepting) return Promise.resolve();
	const pending = active.pending.then(operation);
	// Keep queue usable after a failed command while returning the original
	// rejection to its caller for normal command/prefix error reporting.
	active.pending = pending.catch(() => {});
	return pending;
}

/** Slash commands. Each resolves the active session, then delegates. */
function registerStashCommands(pi: ExtensionAPI, resolve: ActiveResolver): void {
	pi.registerCommand("stash", {
		description: "Stash the current editor draft (prefix+s)",
		handler: async (args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueueOperation(session, () =>
				doStash(session.ui, session.store, session.paths, parseArg(args)),
			);
		},
	});
	pi.registerCommand("stash-list", {
		description: "Open the stash list (prefix+shift+s)",
		handler: async (_args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueueOperation(session, () =>
				openOverlay(
					{ cwd: ctx.cwd, mode: ctx.mode, hasUI: ctx.hasUI, ui: session.ui },
					session.store,
					session.paths,
				),
			);
		},
	});
	pi.registerCommand("stash-pop", {
		description: "Restore a stashed draft into the editor and remove it (default: newest)",
		handler: async (args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueueOperation(session, () =>
				doPop(session.ui, session.store, session.paths, parseArg(args)),
			);
		},
	});
	pi.registerCommand("stash-drop", {
		description: "Delete a stashed draft and its persisted images (default: newest)",
		handler: async (args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueueOperation(session, () =>
				doDrop(session.ui, session.store, session.paths, parseArg(args)),
			);
		},
	});
	pi.registerCommand("stash-clear", {
		description: "Delete every stashed draft for this worktree",
		handler: async (_args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueueOperation(session, () => doClear(session.ui, session.store, session.paths));
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
	if (active?.accepting) {
		reportActionFailure(
			active.ui,
			"stash",
			enqueueOperation(active, () => doStash(active.ui, active.store, active.paths)),
		);
	}
}

function fireList(getter: ActiveGetter, ctx: SessionCtx): void {
	const active = getter();
	if (!active?.accepting) return;
	reportActionFailure(
		active.ui,
		"open stash list",
		enqueueOperation(active, () =>
			openOverlay(
				{ cwd: ctx.cwd, mode: ctx.mode, hasUI: ctx.hasUI, ui: active.ui },
				active.store,
				active.paths,
			),
		),
	);
}

export type PiStashInstallOptions = {
	legacyBaseDir?: string;
};

export function installPiStash(pi: ExtensionAPI, options: PiStashInstallOptions = {}): void {
	let active: ActiveSession | undefined;
	const requireActiveForCommand = makeRequireActive(() => active);

	pi.on("session_start", async (_event, ctx) => {
		if (!isSupportedSession(ctx)) return;

		const baseDir = defaultStashBaseDir();
		const paths = resolveStashPaths(ctx.cwd, baseDir);
		try {
			const migration = await migrateLegacyStash(
				ctx.cwd,
				baseDir,
				options.legacyBaseDir ?? legacyStashBaseDir(),
			);
			if (migration.kind !== "not-needed") {
				ctx.ui.notify("Migrated legacy pi-stash data to the configured Pi agent directory", "info");
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : "unknown legacy migration failure";
			ctx.ui.notify(`pi-stash unavailable: ${reason}`, "error");
			return;
		}
		const store = await loadStashStore(paths);
		await drainAssetCleanup(ctx.ui as StashUi, store, paths);
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

		active = {
			ui: ctx.ui as StashUi,
			store,
			paths,
			stopBinding,
			accepting: true,
			pending: Promise.resolve(),
		};
	});

	pi.on("session_shutdown", async () => {
		const closing = active;
		if (!closing) return;
		closing.accepting = false;
		closing.stopBinding();
		await closing.pending;
		// Clear the widget only after queued work settles, or a late refresh can
		// leak the old worktree's state into the next session.
		closing.ui.setWidget(STASH_WIDGET_KEY, undefined);
		if (active === closing) active = undefined;
	});

	registerStashCommands(pi, requireActiveForCommand);
}

export default function install(pi: ExtensionAPI): void {
	installPiStash(pi);
}
