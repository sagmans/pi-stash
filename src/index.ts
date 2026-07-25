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
import {
	beginAddIntent,
	beginRestoreIntent,
	completeIntent,
	type MutationIntent,
	reconcileMutationIntents,
} from "./intents.ts";
import { legacyStashBaseDir, migrateLegacyStash } from "./migrate.ts";
import { StashOverlayComponent } from "./overlay.ts";
import { defaultStashBaseDir, resolveStashPaths } from "./paths.ts";
import { type Claim, startStashBinding } from "./prefix.ts";
import {
	CommittedMutationError,
	loadStashStore,
	type RestoredAssetCleanup,
	type StashStore,
	UnsupportedStashSchemaError,
} from "./store.ts";
import { sanitizeTerminalText } from "./terminal.ts";
import { createNewId, type ResolvedEntry, type StashEntry } from "./types.ts";
import { themedWidgetLines } from "./widget.ts";

const STASH_WIDGET_KEY = "pi-stash";
const STASH_ACTION_EVENT = "pi-stash:stash";
const LIST_ACTION_EVENT = "pi-stash:list";
const RESTORE_BLOCKED_MESSAGE = "Clear or stash the current editor draft before restoring";
const DROP_FAILED_MESSAGE = "Failed to drop stash entry";
const REFRESH_FAILED_MESSAGE = "Failed to refresh stash";
const CORRUPT_RECOVERY_MESSAGE = "Corrupt stash data was quarantined for recovery";
const ASSET_CLEANUP_FAILED_MESSAGE = "Draft removed, but failed to remove persisted images";
const ASSET_TRANSFER_CLEANUP_FAILED_MESSAGE =
	"Stashed draft, but failed to remove older persisted images";
const LOCK_RELEASE_FAILED_MESSAGE = "failed to release storage lock";
const ROLLBACK_FAILED_MESSAGE = "stash persistence and staged-asset rollback both failed";
const INTENT_ROLLBACK_FAILED_MESSAGE = "stash operation and recovery-intent rollback both failed";
const INTENT_FINALIZE_FAILED_MESSAGE = "failed to finalize crash-recovery intent";
const RESTORE_RECOVERED_MESSAGE = "Recovered a restore interrupted before editor acknowledgement";

// Narrow UI surface the orchestration needs. The real ExtensionContext.ui
// satisfies this structurally; tests pass a minimal fake.
export type StashUi = {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	confirm(title: string, message: string, options?: { signal?: AbortSignal }): Promise<boolean>;
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
	const recoveryPath = store.takeCorruptRecoveryPath();
	if (recoveryPath) {
		safeNotify(ui, `${CORRUPT_RECOVERY_MESSAGE}: ${recoveryPath}`, "warning");
	}
	ui.setWidget(
		STASH_WIDGET_KEY,
		store.entries.length > 0 ? themedWidgetLines(store.entries, ui.theme) : undefined,
	);
}

export type AssetDirRemover = (assetDir: string) => Promise<void>;

function safeNotify(ui: StashUi, message: string, type?: "info" | "warning" | "error"): void {
	ui.notify(sanitizeTerminalText(message), type);
}

function showUnavailable(ui: StashUi, reason: string): void {
	const title = ui.theme.fg("error", " Stash unavailable");
	ui.setWidget(STASH_WIDGET_KEY, [
		`${title} ${ui.theme.fg("muted", sanitizeTerminalText(reason))}`,
	]);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : "unknown error";
}

async function refreshVisibleStore(ui: StashUi, store: StashStore): Promise<void> {
	await store.refresh();
	refreshWidget(ui, store);
}

function committedMutation<Result>(error: unknown): CommittedMutationError<Result> | undefined {
	return error instanceof CommittedMutationError ? error : undefined;
}

async function completeIntentOrAggregate(
	intent: MutationIntent,
	operationError: unknown,
): Promise<void> {
	try {
		await completeIntent(intent);
	} catch (intentError) {
		throw new AggregateError([operationError, intentError], INTENT_ROLLBACK_FAILED_MESSAGE);
	}
}

export type AssetCleanupReport = {
	deleted: string[];
	failed: string[];
};

export async function drainAssetCleanup(
	ui: StashUi,
	store: StashStore,
	paths: ReturnType<typeof resolveStashPaths>,
	remove: AssetDirRemover = removeAssetDir,
	failureMessage = ASSET_CLEANUP_FAILED_MESSAGE,
	signal?: AbortSignal,
): Promise<AssetCleanupReport> {
	const report: AssetCleanupReport = { deleted: [], failed: [] };
	let lockReleaseFailed = false;
	for (const id of [...store.pendingAssetCleanupIds]) {
		if (signal?.aborted) break;
		try {
			await remove(paths.assetDir(id));
			report.deleted.push(id);
			await store.completeAssetCleanup(id);
		} catch (error) {
			if (committedMutation(error)) lockReleaseFailed = true;
			else report.failed.push(id);
		}
	}
	if (signal?.aborted) return report;
	if (report.failed.length > 0) safeNotify(ui, failureMessage, "error");
	if (lockReleaseFailed) {
		safeNotify(ui, `Asset cleanup committed, but ${LOCK_RELEASE_FAILED_MESSAGE}`, "error");
	}
	return report;
}

export async function doAssetCleanup(
	ui: StashUi,
	store: StashStore,
	paths: ReturnType<typeof resolveStashPaths>,
	remove: AssetDirRemover = removeAssetDir,
	signal?: AbortSignal,
): Promise<void> {
	await refreshVisibleStore(ui, store);
	if (signal?.aborted) return;
	const editorText = ui.getEditorText();
	const activeIds = store.restoredAssetLeaseIds.filter((id) =>
		editorText.includes(`${paths.assetDir(id)}${path.sep}`),
	);
	let lifecycle: RestoredAssetCleanup;
	try {
		lifecycle = await store.queueRestoredAssetCleanup(activeIds);
	} catch (error) {
		const committed = committedMutation<RestoredAssetCleanup>(error);
		if (!committed) throw error;
		lifecycle = committed.result;
	}
	const report = await drainAssetCleanup(
		ui,
		store,
		paths,
		remove,
		ASSET_CLEANUP_FAILED_MESSAGE,
		signal,
	);
	if (signal?.aborted) return;
	safeNotify(
		ui,
		`Asset cleanup: deleted ${report.deleted.length}, retained ${lifecycle.retained.length}, failed ${report.failed.length}`,
		report.failed.length > 0 ? "error" : "info",
	);
}

export async function doStash(
	ui: StashUi,
	store: StashStore,
	paths: ReturnType<typeof resolveStashPaths>,
	message?: string,
	remove: AssetDirRemover = removeAssetDir,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) return;
	const text = ui.getEditorText();
	if (text.trim().length === 0) {
		safeNotify(ui, "Nothing to stash", "info");
		return;
	}

	const id = createNewId();
	const assetDir = paths.assetDir(id);
	const intent = await beginAddIntent(paths, id);
	let staged: Awaited<ReturnType<typeof persistTmpImages>>;
	try {
		staged = await persistTmpImages({
			text,
			assetDir,
			ownedAssetsRoot: paths.assetsRoot,
		});
	} catch (error) {
		await completeIntentOrAggregate(intent, error);
		throw error;
	}
	let lockReleaseFailed = false;
	try {
		await store.add({
			id,
			text: staged.text,
			message,
			assetCount: staged.count > 0 ? staged.count : undefined,
			cleanupIds: staged.transferredAssetDirs.map((directory) => path.basename(directory)),
		});
	} catch (error) {
		if (committedMutation(error)) lockReleaseFailed = true;
		else {
			const rollbackErrors: unknown[] = [error];
			try {
				await remove(assetDir);
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
			try {
				await completeIntent(intent);
			} catch (intentError) {
				rollbackErrors.push(intentError);
			}
			if (rollbackErrors.length > 1) {
				throw new AggregateError(rollbackErrors, ROLLBACK_FAILED_MESSAGE);
			}
			throw error;
		}
	}
	let intentFinalizeFailed = false;
	try {
		await completeIntent(intent);
	} catch {
		intentFinalizeFailed = true;
	}
	if (signal?.aborted) return;
	if (ui.getEditorText() === text) ui.setEditorText("");
	if (!lockReleaseFailed) {
		await drainAssetCleanup(
			ui,
			store,
			paths,
			remove,
			ASSET_TRANSFER_CLEANUP_FAILED_MESSAGE,
			signal,
		);
	}
	if (signal?.aborted) return;
	refreshWidget(ui, store);
	const successMessage =
		staged.count > 0
			? `Stashed [0] · ${staged.count} image${staged.count > 1 ? "s" : ""} persisted`
			: "Stashed [0]";
	const failure = lockReleaseFailed ? LOCK_RELEASE_FAILED_MESSAGE : undefined;
	const reportedFailure =
		failure ?? (intentFinalizeFailed ? INTENT_FINALIZE_FAILED_MESSAGE : undefined);
	safeNotify(
		ui,
		reportedFailure ? `${successMessage}, but ${reportedFailure}` : successMessage,
		reportedFailure ? "error" : "info",
	);
}

export async function openOverlay(
	session: StashSession,
	store: StashStore,
	paths: ReturnType<typeof resolveStashPaths>,
	signal?: AbortSignal,
): Promise<void> {
	await refreshVisibleStore(session.ui, store);
	if (signal?.aborted) return;
	if (session.mode !== "tui") {
		const entries = store.entries;
		if (entries.length === 0) {
			safeNotify(session.ui, "No stashed drafts", "info");
			return;
		}
		safeNotify(
			session.ui,
			`${entries.length} stashed draft(s). Use /stash-pop <index> to restore.`,
			"info",
		);
		return;
	}

	const entries = [...store.entries];
	if (entries.length === 0) {
		safeNotify(session.ui, "No stashed drafts", "info");
		return;
	}

	const cwdLabel = shortCwd(session.cwd);
	let overlay: StashOverlayComponent | undefined;
	let cancelOverlay: (() => void) | undefined;
	const chosen = await session.ui.custom<StashEntry | undefined>(
		(tui, _theme, _kb, done) => {
			overlay = new StashOverlayComponent(tui, session.ui.theme, entries, cwdLabel, {
				onRestore: (entry) => done(entry),
				onClose: () => done(undefined),
				onDrop: async (entry) => {
					let dropped: ResolvedEntry | undefined;
					try {
						dropped = await store.drop(entry.id);
					} catch (error) {
						if (!signal?.aborted) {
							safeNotify(session.ui, `${DROP_FAILED_MESSAGE}: ${describeError(error)}`, "error");
						}
						return false;
					}
					if (signal?.aborted) return false;
					if (!dropped) {
						safeNotify(session.ui, "Entry already gone", "warning");
						return true;
					}
					refreshWidget(session.ui, store);
					await drainAssetCleanup(
						session.ui,
						store,
						paths,
						undefined,
						ASSET_CLEANUP_FAILED_MESSAGE,
						signal,
					);
					if (!signal?.aborted) safeNotify(session.ui, `Dropped [${dropped.index}]`, "info");
					return true;
				},
				onRefresh: async () => {
					await refreshVisibleStore(session.ui, store);
					return [...store.entries];
				},
				onRefreshError: (error) => {
					if (!signal?.aborted) {
						safeNotify(session.ui, `${REFRESH_FAILED_MESSAGE}: ${describeError(error)}`, "error");
					}
				},
			});
			cancelOverlay = () => overlay?.cancel();
			if (signal?.aborted) cancelOverlay();
			else signal?.addEventListener("abort", cancelOverlay, { once: true });
			return overlay;
		},
		{ overlay: true, overlayOptions: { width: "70%", maxHeight: "80%" } },
	);
	signal?.removeEventListener("abort", cancelOverlay ?? (() => {}));
	await overlay?.settle();
	if (!chosen || signal?.aborted) return;
	await restoreEntry(
		session.ui,
		store,
		paths,
		chosen.id,
		"Stash entry vanished before restore",
		signal,
	);
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
	safeNotify(ui, RESTORE_BLOCKED_MESSAGE, "warning");
	return false;
}

async function restoreEntry(
	ui: StashUi,
	store: StashStore,
	paths: ReturnType<typeof resolveStashPaths>,
	selector: string | undefined,
	missingMessage: string,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) return;
	let editorBlocked = false;
	let restoredText: string | undefined;
	let intent: MutationIntent | undefined;
	const priorText = ui.getEditorText();
	let resolved: ResolvedEntry | undefined;
	let lockReleaseFailed = false;
	try {
		resolved = await store.pop(selector, async (candidate) => {
			if (signal?.aborted) return false;
			if (!editorIsReadyForRestore(ui)) {
				editorBlocked = true;
				return false;
			}
			intent = await beginRestoreIntent(paths, candidate.entry);
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
			if (restoredText !== undefined && ui.getEditorText() === restoredText) {
				ui.setEditorText(priorText);
			}
			if (intent) await completeIntentOrAggregate(intent, error);
			throw error;
		}
	}
	if (editorBlocked || signal?.aborted) return;
	if (!resolved) {
		refreshWidget(ui, store);
		safeNotify(ui, missingMessage, "warning");
		return;
	}
	let intentFinalizeFailed = false;
	if (intent) {
		try {
			await completeIntent(intent);
		} catch {
			intentFinalizeFailed = true;
		}
	}
	if (signal?.aborted) return;
	refreshWidget(ui, store);
	const successMessage = `Restored [${resolved.index}]`;
	const failure = lockReleaseFailed ? LOCK_RELEASE_FAILED_MESSAGE : undefined;
	const reportedFailure =
		failure ?? (intentFinalizeFailed ? INTENT_FINALIZE_FAILED_MESSAGE : undefined);
	safeNotify(
		ui,
		reportedFailure ? `${successMessage}, but ${reportedFailure}` : successMessage,
		reportedFailure ? "error" : "info",
	);
}

export async function doPop(
	ui: StashUi,
	store: StashStore,
	paths: ReturnType<typeof resolveStashPaths>,
	selector?: string,
	signal?: AbortSignal,
): Promise<void> {
	await restoreEntry(
		ui,
		store,
		paths,
		selector,
		selector ? `No stash entry matching "${selector}"` : "No stashed drafts",
		signal,
	);
}

export async function doDrop(
	ui: StashUi,
	store: StashStore,
	paths: ReturnType<typeof resolveStashPaths>,
	selector?: string,
	remove: AssetDirRemover = removeAssetDir,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) return;
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
	if (signal?.aborted) return;
	if (!resolved) {
		safeNotify(
			ui,
			selector ? `No stash entry matching "${selector}"` : "No stashed drafts",
			"warning",
		);
		return;
	}
	refreshWidget(ui, store);
	if (!lockReleaseFailed) {
		await drainAssetCleanup(ui, store, paths, remove, ASSET_CLEANUP_FAILED_MESSAGE, signal);
	}
	if (signal?.aborted) return;
	const successMessage = `Dropped [${resolved.index}]`;
	safeNotify(
		ui,
		lockReleaseFailed ? `${successMessage}, but ${LOCK_RELEASE_FAILED_MESSAGE}` : successMessage,
		lockReleaseFailed ? "error" : "info",
	);
}

export async function doClear(
	ui: StashUi,
	store: StashStore,
	paths: ReturnType<typeof resolveStashPaths>,
	remove: AssetDirRemover = removeAssetDir,
	signal?: AbortSignal,
): Promise<void> {
	await refreshVisibleStore(ui, store);
	if (signal?.aborted) return;
	if (store.entryCount === 0) {
		safeNotify(ui, "No stashed drafts", "info");
		return;
	}
	const ok = await ui.confirm("Clear stash?", "Delete every stashed draft for this worktree?", {
		signal,
	});
	if (!ok || signal?.aborted) return;
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
	if (signal?.aborted) return;
	refreshWidget(ui, store);
	if (!lockReleaseFailed) {
		await drainAssetCleanup(ui, store, paths, remove, ASSET_CLEANUP_FAILED_MESSAGE, signal);
	}
	if (signal?.aborted) return;
	const successMessage = `Cleared ${ids.length} draft${ids.length === 1 ? "" : "s"}`;
	safeNotify(
		ui,
		lockReleaseFailed ? `${successMessage}, but ${LOCK_RELEASE_FAILED_MESSAGE}` : successMessage,
		lockReleaseFailed ? "error" : "info",
	);
}

type ActiveSession = {
	ui: StashUi;
	store: StashStore;
	paths: ReturnType<typeof resolveStashPaths>;
	stopBinding: () => void;
	abort: AbortController;
	accepting: boolean;
	pending: Promise<void>;
	unavailableReason?: string;
};

type SessionCtx = { cwd: string; mode: string; hasUI: boolean };
type ActiveGetter = () => ActiveSession | undefined;
type ActiveResolver = (ctx: { ui: unknown } | undefined) => ActiveSession | undefined;

/** Trim a single-string command arg; undefined when absent or blank. */
function parseArg(args: unknown): string | undefined {
	return typeof args === "string" && args.trim().length > 0 ? args.trim() : undefined;
}

/** Guard for command handlers: warns and returns nothing before session_start. */
function makeRequireActive(
	getter: ActiveGetter,
	getStartupUnavailableReason: () => string | undefined,
): ActiveResolver {
	return (ctx) => {
		const active = getter();
		const unavailableReason = active?.unavailableReason ?? getStartupUnavailableReason();
		if (unavailableReason) {
			if (ctx && "ui" in ctx && ctx.ui && typeof (ctx.ui as StashUi).notify === "function") {
				safeNotify(ctx.ui as StashUi, unavailableReason, "error");
			}
			return undefined;
		}
		if (!active?.accepting) {
			if (ctx && "ui" in ctx && ctx.ui && typeof (ctx.ui as StashUi).notify === "function") {
				safeNotify(ctx.ui as StashUi, "pi-stash is not ready yet", "warning");
			}
			return undefined;
		}
		return active;
	};
}

function enqueueOperation(
	active: ActiveSession,
	operation: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
	if (!active.accepting) return Promise.resolve();
	if (active.unavailableReason) {
		safeNotify(active.ui, active.unavailableReason, "error");
		return Promise.resolve();
	}
	const pending = active.pending.then(async () => {
		try {
			await operation(active.abort.signal);
		} catch (error) {
			if (!(error instanceof UnsupportedStashSchemaError)) throw error;
			active.unavailableReason = error.message;
			safeNotify(active.ui, error.message, "error");
			showUnavailable(active.ui, error.message);
		}
	});
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
			await enqueueOperation(session, (signal) =>
				doStash(session.ui, session.store, session.paths, parseArg(args), undefined, signal),
			);
		},
	});
	pi.registerCommand("stash-list", {
		description: "Open the stash list (prefix+shift+s)",
		handler: async (_args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueueOperation(session, (signal) =>
				openOverlay(
					{ cwd: ctx.cwd, mode: ctx.mode, hasUI: ctx.hasUI, ui: session.ui },
					session.store,
					session.paths,
					signal,
				),
			);
		},
	});
	pi.registerCommand("stash-pop", {
		description: "Restore a stashed draft into the editor and remove it (default: newest)",
		handler: async (args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueueOperation(session, (signal) =>
				doPop(session.ui, session.store, session.paths, parseArg(args), signal),
			);
		},
	});
	pi.registerCommand("stash-drop", {
		description: "Delete a stashed draft and its persisted images (default: newest)",
		handler: async (args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueueOperation(session, (signal) =>
				doDrop(session.ui, session.store, session.paths, parseArg(args), undefined, signal),
			);
		},
	});
	pi.registerCommand("stash-cleanup", {
		description: "Remove restored image assets no longer referenced by the editor",
		handler: async (_args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueueOperation(session, (signal) =>
				doAssetCleanup(session.ui, session.store, session.paths, undefined, signal),
			);
		},
	});
	pi.registerCommand("stash-clear", {
		description: "Delete every stashed draft for this worktree",
		handler: async (_args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueueOperation(session, (signal) =>
				doClear(session.ui, session.store, session.paths, undefined, signal),
			);
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

function reportActionFailure(
	active: ActiveSession,
	action: string,
	operation: Promise<void>,
): void {
	void operation.catch((error) => {
		if (active.accepting) {
			safeNotify(active.ui, `pi-stash: ${action} failed: ${describeError(error)}`, "error");
		}
	});
}

function fireStash(getter: ActiveGetter): void {
	const active = getter();
	if (active?.accepting) {
		reportActionFailure(
			active,
			"stash",
			enqueueOperation(active, (signal) =>
				doStash(active.ui, active.store, active.paths, undefined, undefined, signal),
			),
		);
	}
}

function fireList(getter: ActiveGetter, ctx: SessionCtx): void {
	const active = getter();
	if (!active?.accepting) return;
	reportActionFailure(
		active,
		"open stash list",
		enqueueOperation(active, (signal) =>
			openOverlay(
				{ cwd: ctx.cwd, mode: ctx.mode, hasUI: ctx.hasUI, ui: active.ui },
				active.store,
				active.paths,
				signal,
			),
		),
	);
}

export type PiStashInstallOptions = {
	legacyBaseDir?: string;
};

export function installPiStash(pi: ExtensionAPI, options: PiStashInstallOptions = {}): void {
	let active: ActiveSession | undefined;
	let startupUnavailableReason: string | undefined;
	const requireActiveForCommand = makeRequireActive(
		() => active,
		() => startupUnavailableReason,
	);

	pi.on("session_start", async (_event, ctx) => {
		if (!isSupportedSession(ctx)) return;

		startupUnavailableReason = undefined;
		const baseDir = defaultStashBaseDir();
		const paths = resolveStashPaths(ctx.cwd, baseDir);
		let store: StashStore;
		try {
			// Detect newer data before legacy migration so no recovery path can
			// mutate or obscure a stash this extension cannot interpret.
			store = await loadStashStore(paths);
			const migration = await migrateLegacyStash(
				ctx.cwd,
				baseDir,
				options.legacyBaseDir ?? legacyStashBaseDir(),
			);
			if (migration.kind !== "not-needed") {
				safeNotify(
					ctx.ui as StashUi,
					"Migrated legacy pi-stash data to the configured Pi agent directory",
					"info",
				);
				store = await loadStashStore(paths);
			}
			const reconciliation = await reconcileMutationIntents(paths, store);
			if (reconciliation.recoveredRestores > 0) {
				safeNotify(ctx.ui as StashUi, RESTORE_RECOVERED_MESSAGE, "warning");
			}
		} catch (error) {
			const reason =
				error instanceof Error ? error.message : "pi-stash unavailable: unknown startup failure";
			startupUnavailableReason = reason.startsWith("pi-stash unavailable:")
				? reason
				: `pi-stash unavailable: ${reason}`;
			safeNotify(ctx.ui as StashUi, startupUnavailableReason, "error");
			if (error instanceof UnsupportedStashSchemaError) {
				showUnavailable(ctx.ui as StashUi, startupUnavailableReason);
			}
			return;
		}
		await drainAssetCleanup(ctx.ui as StashUi, store, paths);
		refreshWidget(ctx.ui as StashUi, store);

		const abort = new AbortController();
		const stopBinding = startStashBinding({
			events: pi.events,
			claims: buildStashClaims(ctx, () => active),
			onInert: () => {
				if (abort.signal.aborted) return;
				safeNotify(
					ctx.ui as StashUi,
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
			abort,
			accepting: true,
			pending: Promise.resolve(),
		};
	});

	pi.on("session_shutdown", async () => {
		const closing = active;
		if (!closing) return;
		active = undefined;
		closing.accepting = false;
		closing.abort.abort();
		closing.stopBinding();
		await closing.pending;
		// Clear the widget only after queued work settles, or a late refresh can
		// leak the old worktree's state into the next session.
		closing.ui.setWidget(STASH_WIDGET_KEY, undefined);
	});

	registerStashCommands(pi, requireActiveForCommand);
}

export default function install(pi: ExtensionAPI): void {
	installPiStash(pi);
}
