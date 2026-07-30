// Maintainer-only companion for exercising the packaged extension in a real Pi TUI.

import path from "node:path";

import type { ExtensionAPI } from "../../src/host.ts";

const QUERY_EVENT = "prefix-keybindings:query";
const AVAILABLE_EVENT = "prefix-keybindings:available";
const REGISTER_EVENT = "prefix-keybindings:register";
const STASH_KEY = "s";
const PREFIX_LABEL = "smoke";
const STASHED_MARKER = "PI_STASH_SMOKE_STASHED";
const RESTORE_READY_MARKER = "PI_STASH_SMOKE_RESTORE_READY";
const FAILED_MARKER = "PI_STASH_SMOKE_FAILED";
const POLL_INTERVAL_MS = 25;
const STASH_TIMEOUT_MS = 15_000;
const REQUIRED_COMMANDS = ["stash", "stash-restore"] as const;

type Claim = {
	eventId: string;
	key: string;
	requester: string;
};

type SmokeConfig = {
	canary: string;
	extensionPath: string;
	imagePath: string;
	phase: "stash" | "restore";
};

function smokeConfig(): SmokeConfig | undefined {
	const phase = process.env.PI_STASH_SMOKE_PHASE;
	const extensionPath = process.env.PI_STASH_SMOKE_EXTENSION;
	const imagePath = process.env.PI_STASH_SMOKE_IMAGE;
	const canary = process.env.PI_STASH_SMOKE_CANARY;
	if ((phase !== "stash" && phase !== "restore") || !extensionPath || !imagePath || !canary) {
		return undefined;
	}
	return { phase, extensionPath, imagePath, canary };
}

function hasPackagedCommands(pi: ExtensionAPI, extensionPath: string): boolean {
	const expectedPath = path.resolve(extensionPath);
	return REQUIRED_COMMANDS.every((name) =>
		pi
			.getCommands()
			.some(
				(command) =>
					command.name === name &&
					command.source === "extension" &&
					path.resolve(command.sourceInfo.path) === expectedPath,
			),
	);
}

export default function installSmokeDriver(pi: ExtensionAPI): void {
	let stashClaim: Claim | undefined;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let pollDeadline = 0;

	const stopPolling = () => {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = undefined;
	};

	pi.events.on(QUERY_EVENT, () => {
		pi.events.emit(AVAILABLE_EVENT, { available: true, prefixKey: PREFIX_LABEL });
	});
	pi.events.on(REGISTER_EVENT, (payload) => {
		if (typeof payload !== "object" || payload === null) return;
		const claim = payload as Record<string, unknown>;
		if (
			claim.key === STASH_KEY &&
			typeof claim.eventId === "string" &&
			typeof claim.requester === "string"
		) {
			stashClaim = claim as Claim;
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI || (ctx.mode !== undefined ? ctx.mode !== "tui" : !process.stdout.isTTY)) return;
		const config = smokeConfig();
		if (!config || !hasPackagedCommands(pi, config.extensionPath)) {
			ctx.ui.notify(FAILED_MARKER, "error");
			return;
		}
		if (config.phase === "restore") {
			ctx.ui.notify(RESTORE_READY_MARKER, "info");
			return;
		}
		if (!stashClaim) {
			ctx.ui.notify(FAILED_MARKER, "error");
			return;
		}

		ctx.ui.setEditorText(["Synthetic smoke draft", config.canary, config.imagePath].join("\n"));
		pi.events.emit(stashClaim.eventId, {
			requester: stashClaim.requester,
			key: stashClaim.key,
		});
		pollDeadline = Date.now() + STASH_TIMEOUT_MS;
		const poll = () => {
			if (ctx.ui.getEditorText().length === 0) {
				pollTimer = undefined;
				ctx.ui.notify(STASHED_MARKER, "info");
				return;
			}
			if (Date.now() >= pollDeadline) {
				pollTimer = undefined;
				ctx.ui.notify(FAILED_MARKER, "error");
				return;
			}
			pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
		};
		pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
	});

	pi.on("session_shutdown", async () => {
		stopPolling();
	});
}
