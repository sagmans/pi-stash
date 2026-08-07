// Pi extension session installation for worktree-scoped draft stashes.

import { loadStashConfig, SHIPPED_STASH_CONFIG, type StashConfig } from "./config.ts";
import { type ExtensionAPI, formatKeyText, type PiUi } from "./host.ts";
import { reconcileMutationIntents } from "./intents.ts";
import { findLegacyMigrationConflicts, legacyStashBaseDir, migrateLegacyStash } from "./migrate.ts";
import { AbortableOperationQueue } from "./operation-queue.ts";
import {
	clearStashWidget,
	doApply,
	doAssetCleanup,
	doClear,
	doDrop,
	doMigrateAll,
	doPop,
	doStash,
	drainAssetCleanup,
	openOverlay,
	refreshWidget,
	safeNotify,
	setWidgetOpenHint,
	showUnavailable,
} from "./operations.ts";
import { defaultStashBaseDir, resolveStashPaths, type StashPaths } from "./paths.ts";
import { loadStashStore, type StashStore, UnsupportedStashSchemaError } from "./store.ts";

export type {
	AssetCleanupReport,
	AssetDirRemover,
	StashOverlayTui,
	StashTarget,
	StashUi,
} from "./operations.ts";
export {
	doApply,
	doAssetCleanup,
	doClear,
	doDrop,
	doMigrateAll,
	doPop,
	doStash,
	drainAssetCleanup,
	openOverlay,
	refreshWidget,
} from "./operations.ts";

const POP_RECOVERED_MESSAGE = "Recovered a pop interrupted before editor acknowledgement";
const STASH_USAGE_MESSAGE = "Usage: /stash <draft>";
const LEGACY_CONFLICT_HINT_MESSAGE =
	"{count} legacy stash conflict{plural} found; run /stash-migrate to inspect {object}";
const MIGRATION_RECHECK_MESSAGE =
	"Migration done; restart pi or run /reload to re-check this directory";

type ActiveSession = {
	cwd: string;
	ui: PiUi;
	store: StashStore;
	paths: StashPaths;
	queue: AbortableOperationQueue;
};

type SessionState =
	| { kind: "inactive" }
	| { kind: "active"; session: ActiveSession }
	| { kind: "unavailable"; cwd: string; reason: string; session?: ActiveSession };

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

function parseSelector(args: unknown): string | undefined {
	return typeof args === "string" && args.trim().length > 0 ? args.trim() : undefined;
}

function parseDraft(args: unknown): string | undefined {
	return typeof args === "string" && args.trim().length > 0 ? args : undefined;
}

function makeRequireActive(getState: () => SessionState): ActiveResolver {
	return (ctx) => {
		const state = getState();
		if (state.kind === "unavailable") {
			if (ctx) safeNotify(ctx.ui, state.reason, "error");
			return undefined;
		}
		if (state.kind === "inactive" || state.session.queue.aborted) {
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
	return active.queue.enqueue(async (signal) => {
		try {
			await operation(signal);
		} catch (error) {
			if (!(error instanceof UnsupportedStashSchemaError)) throw error;
			onUnavailable(error.message);
		}
	});
}

function registerStashCommands(
	pi: ExtensionAPI,
	resolve: ActiveResolver,
	enqueue: (
		active: ActiveSession,
		operation: (signal: AbortSignal) => Promise<void>,
	) => Promise<void>,
	enqueueMigration: (operation: (signal: AbortSignal) => Promise<void>) => Promise<void>,
	legacyBaseDir: string,
	getState: () => SessionState,
	baseDir: string,
): void {
	pi.registerCommand("stash", {
		description: "Stash the draft supplied after the command without changing the editor",
		handler: async (args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			const draft = parseDraft(args);
			if (draft === undefined) {
				safeNotify(ctx.ui, STASH_USAGE_MESSAGE, "warning");
				return;
			}
			await enqueue(session, (signal) => doStash(session, draft, undefined, signal));
		},
	});
	pi.registerCommand("stash-pop", {
		description: "Pop index-or-id (default newest) into an empty editor and remove it",
		handler: async (args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueue(session, (signal) => doPop(session, parseSelector(args), signal));
		},
	});
	pi.registerCommand("stash-list", {
		description: "Search or preview stashes; popping requires an empty editor",
		handler: async (_args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueue(session, (signal) => openOverlay(session, signal));
		},
	});
	pi.registerCommand("stash-drop", {
		description: "Permanently delete index-or-id (default newest) and its copied images",
		handler: async (args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueue(session, (signal) => doDrop(session, parseSelector(args), undefined, signal));
		},
	});
	pi.registerCommand("stash-apply", {
		description: "Apply index-or-id (default newest) into an empty editor without removing it",
		handler: async (args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueue(session, (signal) => doApply(session, parseSelector(args), signal));
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
	pi.registerCommand("stash-migrate", {
		description: "Migrate safe legacy stash scopes and report conflicts for manual review",
		handler: async (_args, ctx) => {
			const requestedState = getState();
			if (requestedState.kind === "inactive" || requestedState.session?.queue.aborted) {
				safeNotify(ctx.ui, "pi-stash is not ready yet", "warning");
				return;
			}
			const cwd =
				requestedState.kind === "active" ? requestedState.session.cwd : requestedState.cwd;
			const migrate = () =>
				enqueueMigration((signal) => doMigrateAll(ctx.ui, baseDir, legacyBaseDir, cwd, signal));
			if (requestedState.kind === "active") {
				await enqueue(requestedState.session, migrate);
			} else {
				await migrate();
			}
			if (getState() === requestedState && requestedState.kind === "unavailable") {
				safeNotify(ctx.ui, MIGRATION_RECHECK_MESSAGE, "info");
			}
		},
	});
	pi.registerCommand("stash-cleanup-images", {
		description: "Delete unreferenced images retained by pops; keep editor references",
		handler: async (_args, ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueue(session, (signal) => doAssetCleanup(session, undefined, signal));
		},
	});
}

function shortcutOpenHint(shortcut: string): string {
	return `${formatKeyText(shortcut)} to open`;
}

function registerStashShortcuts(
	pi: ExtensionAPI,
	config: StashConfig,
	resolve: ActiveResolver,
	enqueue: (
		active: ActiveSession,
		operation: (signal: AbortSignal) => Promise<void>,
	) => Promise<void>,
): void {
	pi.registerShortcut(config.keybindings.stash, {
		description: "Stash the current editor draft",
		handler: async (ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueue(session, (signal) => doStash(session, undefined, undefined, signal));
		},
	});
	pi.registerShortcut(config.keybindings.list, {
		description: "Open the stash list",
		handler: async (ctx) => {
			const session = resolve(ctx);
			if (!session) return;
			await enqueue(session, (signal) => openOverlay(session, signal));
		},
	});
}

export type PiStashInstallOptions = {
	config?: StashConfig;
	legacyBaseDir?: string;
	/** Interactive-terminal probe; defaults to process.stdout.isTTY. */
	isTerminal?: boolean;
};

export function installPiStash(pi: ExtensionAPI, options: PiStashInstallOptions = {}): void {
	const config = options.config ?? SHIPPED_STASH_CONFIG;
	const baseDir = defaultStashBaseDir();
	const legacyBaseDir = options.legacyBaseDir ?? legacyStashBaseDir();
	let state: SessionState = { kind: "inactive" };
	let migrationQueue = new AbortableOperationQueue();

	const closeSessionWork = async (closing?: ActiveSession): Promise<void> => {
		await Promise.all([closing?.queue.close(), migrationQueue.close()]);
		// Settlement precedes clearing so late work cannot leak across sessions.
		if (closing) clearStashWidget(closing.ui);
	};
	const requireActiveForCommand = makeRequireActive(() => state);
	const markUnavailable = (active: ActiveSession, reason: string) => {
		if (sessionFromState(state) !== active) return;
		state = { kind: "unavailable", cwd: active.cwd, reason, session: active };
		safeNotify(active.ui, reason, "error");
		showUnavailable(active.ui, reason);
	};
	const enqueue = (active: ActiveSession, operation: (signal: AbortSignal) => Promise<void>) =>
		enqueueOperation(active, operation, (reason) => markUnavailable(active, reason));

	pi.on("session_start", async (_event, ctx) => {
		const replacing = sessionFromState(state);
		state = { kind: "inactive" };
		await closeSessionWork(replacing);
		migrationQueue = new AbortableOperationQueue();
		if (!isSupportedSession(ctx, options.isTerminal)) return;

		const paths = resolveStashPaths(ctx.cwd, baseDir);
		let store: StashStore;
		try {
			// Newer data must block every migration and recovery mutation.
			store = await loadStashStore(paths);
			// Advisory sweep hint: other scopes may hold legacy stashes that
			// collide with current data and will need the user's decision.
			try {
				const conflicts = await findLegacyMigrationConflicts(baseDir, legacyBaseDir, ctx.cwd);
				if (conflicts.length > 0) {
					safeNotify(
						ctx.ui,
						LEGACY_CONFLICT_HINT_MESSAGE.replace("{count}", String(conflicts.length))
							.replace("{plural}", conflicts.length === 1 ? "" : "s")
							.replace("{object}", conflicts.length === 1 ? "it" : "them"),
						"warning",
					);
				}
			} catch {
				// The hint is advisory; a scan failure must not block startup.
			}
			const didMigrate = await migrateLegacyStash(ctx.cwd, baseDir, legacyBaseDir);
			if (didMigrate) {
				safeNotify(
					ctx.ui,
					"Migrated legacy pi-stash data to the configured Pi agent directory",
					"info",
				);
				store = await loadStashStore(paths);
			}
			const didRecoverPop = await reconcileMutationIntents(paths, store);
			if (didRecoverPop) safeNotify(ctx.ui, POP_RECOVERED_MESSAGE, "warning");
		} catch (error) {
			const detail = error instanceof Error ? error.message : "unknown startup failure";
			const reason = detail.startsWith("pi-stash unavailable:")
				? detail
				: `pi-stash unavailable: ${detail}`;
			state = { kind: "unavailable", cwd: ctx.cwd, reason };
			safeNotify(ctx.ui, reason, "error");
			if (error instanceof UnsupportedStashSchemaError) showUnavailable(ctx.ui, reason);
			return;
		}
		await drainAssetCleanup({ ui: ctx.ui, store, paths });
		setWidgetOpenHint(ctx.ui, shortcutOpenHint(config.keybindings.list));
		refreshWidget(ctx.ui, store);

		state = {
			kind: "active",
			session: {
				cwd: ctx.cwd,
				ui: ctx.ui,
				store,
				paths,
				queue: new AbortableOperationQueue(),
			},
		};
	});

	pi.on("session_shutdown", async () => {
		const closing = sessionFromState(state);
		state = { kind: "inactive" };
		await closeSessionWork(closing);
	});

	registerStashCommands(
		pi,
		requireActiveForCommand,
		enqueue,
		(operation) => migrationQueue.enqueue(operation),
		legacyBaseDir,
		() => state,
		baseDir,
	);
	registerStashShortcuts(pi, config, requireActiveForCommand, enqueue);
}

export default async function install(pi: ExtensionAPI): Promise<void> {
	installPiStash(pi, { config: await loadStashConfig() });
}
