// Pi extension session installation for worktree-scoped draft stashes.

import type { ExtensionAPI, PiUi } from "./host.ts";
import { reconcileMutationIntents } from "./intents.ts";
import { legacyStashBaseDir, migrateLegacyStash } from "./migrate.ts";
import {
	clearStashWidget,
	doAssetCleanup,
	doClear,
	doDrop,
	doRestore,
	doStash,
	drainAssetCleanup,
	openOverlay,
	refreshWidget,
	safeNotify,
	setWidgetOpenHint,
	showUnavailable,
} from "./operations.ts";
import { defaultStashBaseDir, resolveStashPaths, type StashPaths } from "./paths.ts";
import { startStashBinding } from "./prefix.ts";
import { loadStashStore, type StashStore, UnsupportedStashSchemaError } from "./store.ts";
import { createNewId } from "./types.ts";

export type {
	AssetCleanupReport,
	AssetDirRemover,
	StashOverlayTui,
	StashTarget,
	StashUi,
} from "./operations.ts";
export {
	doAssetCleanup,
	doClear,
	doDrop,
	doRestore,
	doStash,
	drainAssetCleanup,
	openOverlay,
	refreshWidget,
} from "./operations.ts";

const PREFIX_BINDING_NAMESPACE = "@sagmans/pi-stash";
const RESTORE_RECOVERED_MESSAGE = "Recovered a restore interrupted before editor acknowledgement";

type ActiveSession = {
	cwd: string;
	ui: PiUi;
	store: StashStore;
	paths: StashPaths;
	stopBinding: () => void;
	abort: AbortController;
	pending: Promise<void>;
};

type SessionState =
	| { kind: "inactive" }
	| { kind: "active"; session: ActiveSession }
	| { kind: "unavailable"; reason: string; session?: ActiveSession };

type ActiveResolver = (ctx: { ui: PiUi } | undefined) => ActiveSession | undefined;

// pi reports a mode and only "tui" is interactive. omp omits mode, but its
// ACP host also reports hasUI with a stubbed no-op editor, so mode-less
// sessions require a real terminal before destructive commands are safe.
export function isSupportedSession(
	session: { mode?: string; hasUI: boolean },
	isTerminal: boolean = process.stdout.isTTY,
): boolean {
	if (!session.hasUI) return false;
	if (session.mode !== undefined) return session.mode === "tui";
	return isTerminal;
}

function sessionFromState(state: SessionState): ActiveSession | undefined {
	return state.kind === "active"
		? state.session
		: state.kind === "unavailable"
			? state.session
			: undefined;
}

function parseArg(args: unknown): string | undefined {
	return typeof args === "string" && args.trim().length > 0 ? args.trim() : undefined;
}

function makeRequireActive(getState: () => SessionState): ActiveResolver {
	return (ctx) => {
		const state = getState();
		if (state.kind === "unavailable") {
			if (ctx) safeNotify(ctx.ui, state.reason, "error");
			return undefined;
		}
		if (state.kind === "inactive" || state.session.abort.signal.aborted) {
			if (ctx) safeNotify(ctx.ui, "pi-stash is not ready yet", "warning");
			return undefined;
		}
		return state.session;
	};
}

function enqueueOperation(
	active: ActiveSession,
	operation: (signal: AbortSignal) => Promise<void>,
	onUnavailable: (reason: string) => void,
): Promise<void> {
	if (active.abort.signal.aborted) return Promise.resolve();
	const pending = active.pending.then(async () => {
		try {
			await operation(active.abort.signal);
		} catch (error) {
			if (!(error instanceof UnsupportedStashSchemaError)) throw error;
			onUnavailable(error.message);
		}
	});
	// A rejected command must not poison later queue settlement during shutdown.
	active.pending = pending.catch(() => {});
	return pending;
}

function registerStashCommands(
	pi: ExtensionAPI,
	resolve: ActiveResolver,
	enqueue: (
		active: ActiveSession,
		operation: (signal: AbortSignal) => Promise<void>,
	) => Promise<void>,
): void {
	pi.registerCommand("stash", {
		description: "Stash draft with optional label; clears editor after persistence",
		handler: async (args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueue(session, (signal) => doStash(session, parseArg(args), undefined, signal));
		},
	});
	pi.registerCommand("stash-list", {
		description: "Search or preview stashes; restoring requires an empty editor",
		handler: async (_args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueue(session, (signal) => openOverlay(session, signal));
		},
	});
	pi.registerCommand("stash-restore", {
		description: "Restore index-or-id (default newest) into an empty editor and remove stash",
		handler: async (args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueue(session, (signal) => doRestore(session, parseArg(args), signal));
		},
	});
	pi.registerCommand("stash-drop", {
		description: "Permanently delete index-or-id (default newest) and its copied images",
		handler: async (args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueue(session, (signal) => doDrop(session, parseArg(args), undefined, signal));
		},
	});
	pi.registerCommand("stash-cleanup", {
		description: "Delete unreferenced restored images; retain editor references",
		handler: async (_args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueue(session, (signal) => doAssetCleanup(session, undefined, signal));
		},
	});
	pi.registerCommand("stash-clear", {
		description: "Confirm, then permanently delete every stash and copied image",
		handler: async (_args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueue(session, (signal) => doClear(session, undefined, signal));
		},
	});
}

function bindingOpenHint(prefixKey: string): string {
	return `${prefixKey} then shift+s to open`;
}

export type PiStashInstallOptions = {
	legacyBaseDir?: string;
	/** Interactive-terminal probe; defaults to process.stdout.isTTY. */
	isTerminal?: boolean;
};

export function installPiStash(pi: ExtensionAPI, options: PiStashInstallOptions = {}): void {
	const bindingRequester = `${PREFIX_BINDING_NAMESPACE}:${createNewId()}`;
	let state: SessionState = { kind: "inactive" };

	const closeActiveSession = async (closing: ActiveSession): Promise<void> => {
		closing.abort.abort();
		closing.stopBinding();
		await closing.pending;
		// Settlement precedes clearing so late work cannot leak across sessions.
		clearStashWidget(closing.ui);
	};
	const requireActiveForCommand = makeRequireActive(() => state);
	const markUnavailable = (active: ActiveSession, reason: string) => {
		if (sessionFromState(state) !== active) return;
		state = { kind: "unavailable", reason, session: active };
		safeNotify(active.ui, reason, "error");
		showUnavailable(active.ui, reason);
	};
	const enqueue = (active: ActiveSession, operation: (signal: AbortSignal) => Promise<void>) =>
		enqueueOperation(active, operation, (reason) => markUnavailable(active, reason));
	const runPrefixAction = (
		action: string,
		operation: (active: ActiveSession, signal: AbortSignal) => Promise<void>,
	): void => {
		if (state.kind !== "active") return;
		const active = state.session;
		void enqueue(active, (signal) => operation(active, signal)).catch((error) => {
			if (!active.abort.signal.aborted) {
				const reason = error instanceof Error ? error.message : "unknown error";
				safeNotify(active.ui, `pi-stash: ${action} failed: ${reason}`, "error");
			}
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		const replacing = sessionFromState(state);
		state = { kind: "inactive" };
		if (replacing) await closeActiveSession(replacing);
		if (!isSupportedSession(ctx, options.isTerminal)) return;

		const baseDir = defaultStashBaseDir();
		const paths = resolveStashPaths(ctx.cwd, baseDir);
		let store: StashStore;
		try {
			// Newer data must block every migration and recovery mutation.
			store = await loadStashStore(paths);
			const didMigrate = await migrateLegacyStash(
				ctx.cwd,
				baseDir,
				options.legacyBaseDir ?? legacyStashBaseDir(),
			);
			if (didMigrate) {
				safeNotify(
					ctx.ui,
					"Migrated legacy pi-stash data to the configured Pi agent directory",
					"info",
				);
				store = await loadStashStore(paths);
			}
			const didRecoverRestore = await reconcileMutationIntents(paths, store);
			if (didRecoverRestore) safeNotify(ctx.ui, RESTORE_RECOVERED_MESSAGE, "warning");
		} catch (error) {
			const detail = error instanceof Error ? error.message : "unknown startup failure";
			const reason = detail.startsWith("pi-stash unavailable:")
				? detail
				: `pi-stash unavailable: ${detail}`;
			state = { kind: "unavailable", reason };
			safeNotify(ctx.ui, reason, "error");
			if (error instanceof UnsupportedStashSchemaError) showUnavailable(ctx.ui, reason);
			return;
		}
		await drainAssetCleanup({ ui: ctx.ui, store, paths });
		setWidgetOpenHint(ctx.ui);
		refreshWidget(ctx.ui, store);

		const abort = new AbortController();
		const stopBinding = startStashBinding({
			events: pi.events,
			requester: bindingRequester,
			onStash: () =>
				runPrefixAction("stash", (session, signal) =>
					doStash(session, undefined, undefined, signal),
				),
			onList: () =>
				runPrefixAction("open stash list", (session, signal) => openOverlay(session, signal)),
			onActive: (prefixKey) => {
				if (abort.signal.aborted) return;
				setWidgetOpenHint(ctx.ui, bindingOpenHint(prefixKey));
				refreshWidget(ctx.ui, store);
			},
			onInert: () => {
				if (abort.signal.aborted) return;
				setWidgetOpenHint(ctx.ui);
				refreshWidget(ctx.ui, store);
				safeNotify(
					ctx.ui,
					"pi-stash: prefix-keybindings not detected; use /stash and /stash-list",
					"warning",
				);
			},
		});

		state = {
			kind: "active",
			session: {
				cwd: ctx.cwd,
				ui: ctx.ui,
				store,
				paths,
				stopBinding,
				abort,
				pending: Promise.resolve(),
			},
		};
	});

	pi.on("session_shutdown", async () => {
		const closing = sessionFromState(state);
		state = { kind: "inactive" };
		if (closing) await closeActiveSession(closing);
	});

	registerStashCommands(pi, requireActiveForCommand, enqueue);
}

export default function install(pi: ExtensionAPI): void {
	installPiStash(pi);
}
