// Maintainer-only companion for exercising the packaged extension in a real Pi TUI.

import path from "node:path";

import type { ExtensionAPI } from "../../src/host.ts";

const STASH_READY_MARKER = "PI_STASH_SMOKE_STASH_READY";
const STASHED_MARKER = "PI_STASH_SMOKE_STASHED";
const RESTORE_READY_MARKER = "PI_STASH_SMOKE_RESTORE_READY";
const CLEANUP_READY_MARKER = "PI_STASH_SMOKE_CLEANUP_READY";
const FAILED_MARKER = "PI_STASH_SMOKE_FAILED";
const POLL_INTERVAL_MS = 25;
const STASH_TIMEOUT_MS = 15_000;
// Pi notifications are transient: repeat markers so the Herdr-side watcher
// cannot miss them between its own poll cycles.
const MARKER_REPEAT_MS = 250;
const REQUIRED_COMMANDS = ["stash", "stash-restore", "stash-pop", "stash-cleanup"] as const;

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
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let markerTimer: ReturnType<typeof setTimeout> | undefined;
	let pollDeadline = 0;

	const stopPolling = () => {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = undefined;
	};
	const stopMarker = () => {
		if (markerTimer) clearTimeout(markerTimer);
		markerTimer = undefined;
	};
	const emitMarker = (
		notify: (text: string, level: "info" | "error") => void,
		marker: string,
		level: "info" | "error",
	) => {
		stopMarker();
		const deadline = Date.now() + STASH_TIMEOUT_MS;
		const tick = () => {
			notify(marker, level);
			if (Date.now() >= deadline) {
				markerTimer = undefined;
				return;
			}
			markerTimer = setTimeout(tick, MARKER_REPEAT_MS);
		};
		tick();
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI || (ctx.mode !== undefined ? ctx.mode !== "tui" : !process.stdout.isTTY)) return;
		const config = smokeConfig();
		if (!config || !hasPackagedCommands(pi, config.extensionPath)) {
			emitMarker((text, level) => ctx.ui.notify(text, level), FAILED_MARKER, "error");
			return;
		}
		if (config.phase === "restore") {
			emitMarker((text, level) => ctx.ui.notify(text, level), RESTORE_READY_MARKER, "info");
			pollDeadline = Date.now() + STASH_TIMEOUT_MS;
			const poll = () => {
				if (ctx.ui.getEditorText().includes(config.canary)) {
					pollTimer = undefined;
					ctx.ui.setEditorText("");
					emitMarker((text, level) => ctx.ui.notify(text, level), CLEANUP_READY_MARKER, "info");
					return;
				}
				if (Date.now() >= pollDeadline) {
					pollTimer = undefined;
					emitMarker((text, level) => ctx.ui.notify(text, level), FAILED_MARKER, "error");
					return;
				}
				pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
			};
			pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
			return;
		}
		ctx.ui.setEditorText(["Synthetic smoke draft", config.canary, config.imagePath].join("\n"));
		emitMarker((text, level) => ctx.ui.notify(text, level), STASH_READY_MARKER, "info");
		pollDeadline = Date.now() + STASH_TIMEOUT_MS;
		const poll = () => {
			if (ctx.ui.getEditorText().length === 0) {
				pollTimer = undefined;
				emitMarker((text, level) => ctx.ui.notify(text, level), STASHED_MARKER, "info");
				return;
			}
			if (Date.now() >= pollDeadline) {
				pollTimer = undefined;
				emitMarker((text, level) => ctx.ui.notify(text, level), FAILED_MARKER, "error");
				return;
			}
			pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
		};
		pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
	});

	pi.on("session_shutdown", async () => {
		stopPolling();
		stopMarker();
	});
}
