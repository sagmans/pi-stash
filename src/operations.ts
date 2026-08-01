// User-facing stash operations, independent from extension session installation.

import path from "node:path";

import { persistTmpImages } from "./assets.ts";
import type { PiUi, StashOverlayTui } from "./host.ts";
import {
	beginAddIntent,
	beginRestoreIntent,
	completeIntent,
	type MutationIntent,
} from "./intents.ts";
import { CommittedMutationError } from "./lock.ts";
import { StashOverlayComponent } from "./overlay.ts";
import { type StashPaths, scopeLabel } from "./paths.ts";
import { removePrivateDirectory, syncPrivateDirectory } from "./private-fs.ts";
import type { RestoredAssetCleanup, StashStore } from "./store.ts";
import { sanitizeTerminalText } from "./terminal.ts";
import { createNewId, type ResolvedEntry, type StashEntry } from "./types.ts";
import { themedWidgetLines } from "./widget.ts";

const STASH_WIDGET_KEY = "pi-stash";
const widgetOpenHints = new WeakMap<PiUi, string>();
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
const DIRECTORY_SYNC_FAILED_MESSAGE = "storage directory sync failed";
const ROLLBACK_FAILED_MESSAGE = "stash persistence and staged-asset rollback both failed";
const INTENT_ROLLBACK_FAILED_MESSAGE = "stash operation and recovery-intent rollback both failed";
const INTENT_FINALIZE_FAILED_MESSAGE = "failed to finalize crash-recovery intent";

export type StashUi = PiUi;
export type { StashOverlayTui };

export type StashTarget = {
	ui: PiUi;
	store: StashStore;
	paths: StashPaths;
};

export type AssetDirRemover = (assetDir: string) => Promise<void>;

export function safeNotify(ui: PiUi, message: string, type?: "info" | "warning" | "error"): void {
	ui.notify(sanitizeTerminalText(message), type);
}

export function showUnavailable(ui: PiUi, reason: string): void {
	const title = ui.theme.fg("error", " Stash unavailable");
	ui.setWidget(STASH_WIDGET_KEY, [
		`${title} ${ui.theme.fg("muted", sanitizeTerminalText(reason))}`,
	]);
}

export function clearStashWidget(ui: PiUi): void {
	widgetOpenHints.delete(ui);
	ui.setWidget(STASH_WIDGET_KEY, undefined);
}

export function setWidgetOpenHint(ui: PiUi, hint?: string): void {
	if (hint) widgetOpenHints.set(ui, hint);
	else widgetOpenHints.delete(ui);
}

export function refreshWidget(ui: PiUi, store: StashStore): void {
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
	const openHint = widgetOpenHints.get(ui);
	ui.setWidget(STASH_WIDGET_KEY, (_tui, theme) => ({
		render: (width) => themedWidgetLines(entries, theme, { openHint, width }),
		invalidate: () => {},
	}));
}

async function refreshVisibleStore(ui: PiUi, store: StashStore): Promise<void> {
	await store.refresh();
	refreshWidget(ui, store);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : "unknown error";
}

function committedMutation<Result>(error: unknown): CommittedMutationError<Result> | undefined {
	return error instanceof CommittedMutationError ? error : undefined;
}

function describeCommittedFailure(error: CommittedMutationError): string {
	return error.failures
		.map(({ phase }) =>
			phase === "lock-release" ? LOCK_RELEASE_FAILED_MESSAGE : DIRECTORY_SYNC_FAILED_MESSAGE,
		)
		.join(" and ");
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
	removed: number;
	removalFailed: number;
	acknowledgementFailed: number;
};

export async function drainAssetCleanup(
	target: StashTarget,
	remove: AssetDirRemover = removePrivateDirectory,
	failureMessage = ASSET_CLEANUP_FAILED_MESSAGE,
	signal?: AbortSignal,
	syncDirectory: typeof syncPrivateDirectory = syncPrivateDirectory,
): Promise<AssetCleanupReport> {
	const { ui, store, paths } = target;
	const pendingIds = [...store.pendingAssetCleanupIds];
	if (pendingIds.length > 0) {
		// Cleanup is destructive, so the metadata that surrendered asset ownership
		// must survive a crash before any directory can be removed.
		await syncDirectory(path.dirname(paths.stashFile), "stash storage directory");
	}
	const report: AssetCleanupReport = {
		removed: 0,
		removalFailed: 0,
		acknowledgementFailed: 0,
	};
	const committedFailures: CommittedMutationError[] = [];
	for (const id of pendingIds) {
		if (signal?.aborted) break;
		try {
			await remove(paths.assetDir(id));
			report.removed += 1;
		} catch {
			report.removalFailed += 1;
			continue;
		}
		try {
			await store.completeAssetCleanup(id);
		} catch (error) {
			const committed = committedMutation(error);
			if (committed) committedFailures.push(committed);
			else report.acknowledgementFailed += 1;
		}
	}
	if (signal?.aborted) return report;
	if (report.removalFailed > 0 || report.acknowledgementFailed > 0) {
		safeNotify(ui, failureMessage, "error");
	}
	for (const failure of committedFailures) {
		safeNotify(ui, `Asset cleanup committed, but ${describeCommittedFailure(failure)}`, "error");
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
		safeNotify(ui, `Asset cleanup committed, but ${describeCommittedFailure(committed)}`, "error");
	}
	const report = await drainAssetCleanup(target, remove, ASSET_CLEANUP_FAILED_MESSAGE, signal);
	if (signal?.aborted) return;
	safeNotify(
		ui,
		`Asset cleanup: removed ${report.removed}, retained ${lifecycle.retained.length}, removal failed ${report.removalFailed}, acknowledgement failed ${report.acknowledgementFailed}`,
		report.removalFailed > 0 || report.acknowledgementFailed > 0 ? "error" : "info",
	);
}

export async function doStash(
	target: StashTarget,
	draft?: string,
	remove: AssetDirRemover = removePrivateDirectory,
	signal?: AbortSignal,
): Promise<void> {
	const { ui, store, paths } = target;
	if (signal?.aborted) return;
	// Only shortcut invocations omit draft and therefore own editor clearing.
	const readsEditor = draft === undefined;
	const text = draft ?? ui.getEditorText();
	if (text.trim().length === 0) {
		safeNotify(ui, "Nothing to stash", "info");
		return;
	}

	const id = createNewId();
	const assetDir = paths.assetDir(id);
	const intent = await beginAddIntent(paths, id);
	let staged: Awaited<ReturnType<typeof persistTmpImages>>;
	try {
		staged = await persistTmpImages({ text, assetDir, ownedAssetsRoot: paths.assetsRoot });
	} catch (error) {
		await completeIntentOrAggregate(intent, error);
		throw error;
	}
	let committedFailure: CommittedMutationError<StashEntry> | undefined;
	try {
		await store.add({
			id,
			text: staged.text,
			assetCount: staged.count > 0 ? staged.count : undefined,
			cleanupIds: staged.transferredAssetIds,
		});
	} catch (error) {
		const committed = committedMutation<StashEntry>(error);
		if (committed) committedFailure = committed;
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
	if (readsEditor && ui.getEditorText() === text) ui.setEditorText("");
	if (!committedFailure?.hasFailure("lock-release")) {
		await drainAssetCleanup(target, remove, ASSET_TRANSFER_CLEANUP_FAILED_MESSAGE, signal);
	}
	if (signal?.aborted) return;
	refreshWidget(ui, store);
	const successMessage =
		staged.count > 0
			? `Stashed [0] · ${staged.count} image${staged.count > 1 ? "s" : ""} persisted`
			: "Stashed [0]";
	const failure = committedFailure ? describeCommittedFailure(committedFailure) : undefined;
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
		(tui, _theme, keybindings, done) => {
			overlay = new StashOverlayComponent(
				tui,
				ui.theme,
				entries,
				cwdLabel,
				{
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
				},
				keybindings,
			);
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

function editorIsReadyForRestore(ui: PiUi): boolean {
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
	let committedFailure: CommittedMutationError<ResolvedEntry | undefined> | undefined;
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
			committedFailure = committed;
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
	const failure = committedFailure ? describeCommittedFailure(committedFailure) : undefined;
	const reportedFailure =
		failure ?? (intentFinalizeFailed ? INTENT_FINALIZE_FAILED_MESSAGE : undefined);
	safeNotify(
		ui,
		reportedFailure ? `${successMessage}, but ${reportedFailure}` : successMessage,
		reportedFailure ? "error" : "info",
	);
}

export async function doRestore(
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
	let committedFailure: CommittedMutationError<ResolvedEntry | undefined> | undefined;
	try {
		resolved = await store.drop(selector);
	} catch (error) {
		const committed = committedMutation<ResolvedEntry | undefined>(error);
		if (!committed) throw error;
		resolved = committed.result;
		committedFailure = committed;
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
	if (!committedFailure?.hasFailure("lock-release")) {
		await drainAssetCleanup(target, remove, ASSET_CLEANUP_FAILED_MESSAGE, signal);
	}
	if (signal?.aborted) return;
	const successMessage = `Dropped [${resolved.index}]`;
	const failure = committedFailure ? describeCommittedFailure(committedFailure) : undefined;
	safeNotify(
		ui,
		failure ? `${successMessage}, but ${failure}` : successMessage,
		failure ? "error" : "info",
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
	if (
		store.entryCount === 0 &&
		store.restoredAssetLeaseIds.length === 0 &&
		store.pendingAssetCleanupIds.length === 0
	) {
		safeNotify(ui, "No stashed drafts", "info");
		return;
	}
	const ok = await ui.confirm(
		"Clear stash?",
		"Delete every stashed draft and copied image for this worktree?",
		{ signal },
	);
	if (!ok || signal?.aborted) return;
	let ids: string[];
	let committedFailure: CommittedMutationError<string[]> | undefined;
	try {
		ids = await store.clear();
	} catch (error) {
		const committed = committedMutation<string[]>(error);
		if (!committed) throw error;
		ids = committed.result;
		committedFailure = committed;
	}
	if (signal?.aborted) return;
	refreshWidget(ui, store);
	if (!committedFailure?.hasFailure("lock-release")) {
		await drainAssetCleanup(target, remove, ASSET_CLEANUP_FAILED_MESSAGE, signal);
	}
	if (signal?.aborted) return;
	const successMessage = `Cleared ${ids.length} draft${ids.length === 1 ? "" : "s"}`;
	const failure = committedFailure ? describeCommittedFailure(committedFailure) : undefined;
	safeNotify(
		ui,
		failure ? `${successMessage}, but ${failure}` : successMessage,
		failure ? "error" : "info",
	);
}
