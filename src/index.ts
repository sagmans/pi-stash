// Pi extension orchestration for worktree-scoped draft stashes.

import path from "node:path";

import { persistTmpImages } from "./assets.ts";
import type { ExtensionAPI, Theme } from "./host.ts";
import {
	beginAddIntent,
	beginRestoreIntent,
	completeIntent,
	type MutationIntent,
	reconcileMutationIntents,
} from "./intents.ts";
import { legacyStashBaseDir, migrateLegacyStash } from "./migrate.ts";
import { StashOverlayComponent } from "./overlay.ts";
import { defaultStashBaseDir, resolveStashPaths, type StashPaths, scopeLabel } from "./paths.ts";
import { startStashBinding } from "./prefix.ts";
import { removePrivateDirectory } from "./private-fs.ts";
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
const PREFIX_BINDING_NAMESPACE = "@sagmans/pi-stash";
const widgetOpenHints = new WeakMap<StashUi, string>();
const RESTORE_BLOCKED_MESSAGE = "Clear or stash the current editor draft before restoring";
const DROP_FAILED_MESSAGE = "Failed to drop stash entry";
const REFRESH_FAILED_MESSAGE = "Failed to refresh stash";
const CORRUPT_RECOVERY_MESSAGE = "Corrupt stash data was quarantined for recovery";
const UPGRADE_SYNC_WARNING_MESSAGE =
	"Stash schema upgrade committed, but the storage directory sync failed";
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
type StashWidgetFactory = (
	tui: unknown,
	theme: Pick<Theme, "fg">,
) => { render(width: number): string[]; invalidate(): void };

export type StashUi = {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	confirm(title: string, message: string, options?: { signal?: AbortSignal }): Promise<boolean>;
	getEditorText(): string;
	setEditorText(text: string): void;
	setWidget(key: string, content: string[] | StashWidgetFactory | undefined): void;
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

/** Bundle of the session operands every stash operation threads through. */
export type StashTarget = {
	ui: StashUi;
	store: StashStore;
	paths: StashPaths;
};

export function isSupportedSession(session: { mode: string; hasUI: boolean }): boolean {
	return session.mode === "tui" && session.hasUI;
}

export function refreshWidget(ui: StashUi, store: StashStore): void {
	const recoveryPath = store.takeCorruptRecoveryPath();
	if (recoveryPath) {
		safeNotify(ui, `${CORRUPT_RECOVERY_MESSAGE}: ${recoveryPath}`, "warning");
	}
	const durabilityWarning = store.takeDurabilityWarning();
	if (durabilityWarning) {
		safeNotify(ui, `${UPGRADE_SYNC_WARNING_MESSAGE}: ${durabilityWarning}`, "warning");
	}
	if (store.entries.length === 0) {
		ui.setWidget(STASH_WIDGET_KEY, undefined);
		return;
	}
	const entries = store.entries;
	const openHint = widgetOpenHints.get(ui) ?? false;
	ui.setWidget(STASH_WIDGET_KEY, (_tui, theme) => ({
		render: (width) => themedWidgetLines(entries, theme, { openHint, width }),
		invalidate: () => {},
	}));
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
	target: StashTarget,
	remove: AssetDirRemover = removePrivateDirectory,
	failureMessage = ASSET_CLEANUP_FAILED_MESSAGE,
	signal?: AbortSignal,
): Promise<AssetCleanupReport> {
	const { ui, store, paths } = target;
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
	target: StashTarget,
	remove: AssetDirRemover = removePrivateDirectory,
	signal?: AbortSignal,
): Promise<void> {
	const { ui, store, paths } = target;
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
	const report = await drainAssetCleanup(target, remove, ASSET_CLEANUP_FAILED_MESSAGE, signal);
	if (signal?.aborted) return;
	safeNotify(
		ui,
		`Asset cleanup: deleted ${report.deleted.length}, retained ${lifecycle.retained.length}, failed ${report.failed.length}`,
		report.failed.length > 0 ? "error" : "info",
	);
}

export async function doStash(
	target: StashTarget,
	message?: string,
	remove: AssetDirRemover = removePrivateDirectory,
	signal?: AbortSignal,
): Promise<void> {
	const { ui, store, paths } = target;
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
		await drainAssetCleanup(target, remove, ASSET_TRANSFER_CLEANUP_FAILED_MESSAGE, signal);
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
	target: StashTarget & { cwd: string },
	signal?: AbortSignal,
): Promise<void> {
	const { cwd, ui, store } = target;
	await refreshVisibleStore(ui, store);
	if (signal?.aborted) return;
	const entries = store.entries;
	if (entries.length === 0) {
		safeNotify(ui, "No stashed drafts", "info");
		return;
	}

	const cwdLabel = scopeLabel(cwd, process.env.HOME);
	let overlay: StashOverlayComponent | undefined;
	let cancelOverlay: (() => void) | undefined;
	const chosen = await ui.custom<StashEntry | undefined>(
		(tui, _theme, _kb, done) => {
			overlay = new StashOverlayComponent(tui, ui.theme, entries, cwdLabel, {
				onRestore: (entry) => done(entry),
				onClose: () => done(undefined),
				onDrop: async (entry) => {
					let dropped: ResolvedEntry | undefined;
					try {
						dropped = await store.drop(entry.id);
					} catch (error) {
						if (!signal?.aborted) {
							safeNotify(ui, `${DROP_FAILED_MESSAGE}: ${describeError(error)}`, "error");
						}
						return false;
					}
					if (signal?.aborted) return false;
					if (!dropped) {
						safeNotify(ui, "Entry already gone", "warning");
						return true;
					}
					refreshWidget(ui, store);
					await drainAssetCleanup(target, undefined, ASSET_CLEANUP_FAILED_MESSAGE, signal);
					if (!signal?.aborted) safeNotify(ui, `Dropped [${dropped.index}]`, "info");
					return true;
				},
				onRefresh: async () => {
					await refreshVisibleStore(ui, store);
					return store.entries;
				},
				onRefreshError: (error) => {
					if (!signal?.aborted) {
						safeNotify(ui, `${REFRESH_FAILED_MESSAGE}: ${describeError(error)}`, "error");
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
	await restoreEntry(target, chosen.id, "Stash entry vanished before restore", signal);
}

function editorIsReadyForRestore(ui: StashUi): boolean {
	if (ui.getEditorText().trim().length === 0) return true;
	safeNotify(ui, RESTORE_BLOCKED_MESSAGE, "warning");
	return false;
}

async function restoreEntry(
	target: StashTarget,
	selector: string | undefined,
	missingMessage: string,
	signal?: AbortSignal,
): Promise<void> {
	const { ui, store, paths } = target;
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
	if (editorBlocked || (!resolved && signal?.aborted)) return;
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
	target: StashTarget,
	selector?: string,
	signal?: AbortSignal,
): Promise<void> {
	await restoreEntry(
		target,
		selector,
		selector ? `No stash entry matching "${selector}"` : "No stashed drafts",
		signal,
	);
}

export async function doDrop(
	target: StashTarget,
	selector?: string,
	remove: AssetDirRemover = removePrivateDirectory,
	signal?: AbortSignal,
): Promise<void> {
	const { ui, store } = target;
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
		await drainAssetCleanup(target, remove, ASSET_CLEANUP_FAILED_MESSAGE, signal);
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
	target: StashTarget,
	remove: AssetDirRemover = removePrivateDirectory,
	signal?: AbortSignal,
): Promise<void> {
	const { ui, store } = target;
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
		await drainAssetCleanup(target, remove, ASSET_CLEANUP_FAILED_MESSAGE, signal);
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
	cwd: string;
	ui: StashUi;
	store: StashStore;
	paths: StashPaths;
	stopBinding: () => void;
	abort: AbortController;
	pending: Promise<void>;
	unavailableReason?: string;
};
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
		if (!active || active.abort.signal.aborted) {
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
	if (active.abort.signal.aborted) return Promise.resolve();
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
		description: "Stash draft with optional label; clears editor after persistence",
		handler: async (args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueueOperation(session, (signal) =>
				doStash(session, parseArg(args), undefined, signal),
			);
		},
	});
	pi.registerCommand("stash-list", {
		description: "Search or preview stashes; restoring requires an empty editor",
		handler: async (_args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueueOperation(session, (signal) => openOverlay(session, signal));
		},
	});
	pi.registerCommand("stash-pop", {
		description: "Restore index-or-id (default newest) into an empty editor and remove stash",
		handler: async (args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueueOperation(session, (signal) => doPop(session, parseArg(args), signal));
		},
	});
	pi.registerCommand("stash-drop", {
		description: "Permanently delete index-or-id (default newest) and its copied images",
		handler: async (args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueueOperation(session, (signal) =>
				doDrop(session, parseArg(args), undefined, signal),
			);
		},
	});
	pi.registerCommand("stash-cleanup", {
		description: "Delete unreferenced restored images; retain editor references",
		handler: async (_args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueueOperation(session, (signal) => doAssetCleanup(session, undefined, signal));
		},
	});
	pi.registerCommand("stash-clear", {
		description: "Confirm, then permanently delete every stash and copied image",
		handler: async (_args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueueOperation(session, (signal) => doClear(session, undefined, signal));
		},
	});
}

function bindingOpenHint(prefixKey: string): string {
	return `${prefixKey} then shift+s to open`;
}

function runPrefixAction(
	getter: ActiveGetter,
	action: string,
	operation: (active: ActiveSession, signal: AbortSignal) => Promise<void>,
): void {
	const active = getter();
	if (!active || active.abort.signal.aborted) return;
	void enqueueOperation(active, (signal) => operation(active, signal)).catch((error) => {
		if (!active.abort.signal.aborted) {
			safeNotify(active.ui, `pi-stash: ${action} failed: ${describeError(error)}`, "error");
		}
	});
}

export type PiStashInstallOptions = {
	legacyBaseDir?: string;
};

export function installPiStash(pi: ExtensionAPI, options: PiStashInstallOptions = {}): void {
	const bindingRequester = `${PREFIX_BINDING_NAMESPACE}:${createNewId()}`;
	let active: ActiveSession | undefined;
	let startupUnavailableReason: string | undefined;

	const closeActiveSession = async (closing: ActiveSession): Promise<void> => {
		closing.abort.abort();
		closing.stopBinding();
		await closing.pending;
		widgetOpenHints.delete(closing.ui);
		// Clear only after queued work settles, or a late refresh can leak the
		// previous worktree's state into a replacement session.
		closing.ui.setWidget(STASH_WIDGET_KEY, undefined);
	};
	const requireActiveForCommand = makeRequireActive(
		() => active,
		() => startupUnavailableReason,
	);

	pi.on("session_start", async (_event, ctx) => {
		const replacing = active;
		active = undefined;
		if (replacing) await closeActiveSession(replacing);
		if (!isSupportedSession(ctx)) return;

		startupUnavailableReason = undefined;
		const baseDir = defaultStashBaseDir();
		const paths = resolveStashPaths(ctx.cwd, baseDir);
		let store: StashStore;
		try {
			// Detect newer data before legacy migration so no recovery path can
			// mutate or obscure a stash this extension cannot interpret.
			store = await loadStashStore(paths);
			const didMigrate = await migrateLegacyStash(
				ctx.cwd,
				baseDir,
				options.legacyBaseDir ?? legacyStashBaseDir(),
			);
			if (didMigrate) {
				safeNotify(
					ctx.ui as StashUi,
					"Migrated legacy pi-stash data to the configured Pi agent directory",
					"info",
				);
				store = await loadStashStore(paths);
			}
			const didRecoverRestore = await reconcileMutationIntents(paths, store);
			if (didRecoverRestore) {
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
		const ui = ctx.ui as StashUi;
		await drainAssetCleanup({ ui, store, paths });
		widgetOpenHints.delete(ui);
		refreshWidget(ui, store);

		const abort = new AbortController();
		const stopBinding = startStashBinding({
			events: pi.events,
			requester: bindingRequester,
			onStash: () =>
				runPrefixAction(
					() => active,
					"stash",
					(session, signal) => doStash(session, undefined, undefined, signal),
				),
			onList: () =>
				runPrefixAction(
					() => active,
					"open stash list",
					(session, signal) => openOverlay(session, signal),
				),
			onActive: (prefixKey) => {
				if (abort.signal.aborted) return;
				widgetOpenHints.set(ui, bindingOpenHint(prefixKey));
				refreshWidget(ui, store);
			},
			onInert: () => {
				if (abort.signal.aborted) return;
				widgetOpenHints.delete(ui);
				refreshWidget(ui, store);
				safeNotify(
					ui,
					"pi-stash: prefix-keybindings not detected; use /stash and /stash-list",
					"warning",
				);
			},
		});

		active = {
			cwd: ctx.cwd,
			ui,
			store,
			paths,
			stopBinding,
			abort,
			pending: Promise.resolve(),
		};
	});

	pi.on("session_shutdown", async () => {
		const closing = active;
		if (!closing) return;
		active = undefined;
		await closeActiveSession(closing);
	});

	registerStashCommands(pi, requireActiveForCommand);
}

export default function install(pi: ExtensionAPI): void {
	installPiStash(pi);
}
