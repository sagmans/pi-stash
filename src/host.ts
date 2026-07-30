// Minimal structural contract with Pi. Pi injects this API when loading the extension;
// importing the full host package would duplicate Pi and its complete provider stack.

import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type Component, getKeybindings, type Keybinding } from "@earendil-works/pi-tui";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const DEFAULT_CONFIG_DIR = ".pi";
const DEFAULT_AGENT_DIR = "agent";
const TILDE_PREFIX = "~/";
const FILE_URL_PREFIX = "file://";
const MAC_ALT_KEY = "alt";
const MAC_ALT_LABEL = "option";

export type Theme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

export type PiUi = {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	getEditorText(): string;
	setEditorText(text: string): void;
};

export type PiSessionContext = {
	cwd: string;
	/** Present under pi (only "tui" is interactive); omp's context omits it. */
	mode?: string;
	hasUI: boolean;
	ui: PiUi;
};

export type ExtensionAPI = {
	events: {
		emit(event: string, payload?: unknown): void;
		on(event: string, handler: (payload?: unknown) => void): () => void;
	};
	on(event: string, handler: (event: unknown, context: PiSessionContext) => unknown): void;
	registerCommand(
		name: string,
		command: {
			description: string;
			handler(args: unknown, context: PiSessionContext): unknown;
		},
	): void;
	getCommands(): readonly {
		name: string;
		source: string;
		sourceInfo: { path: string };
	}[];
};

/** Resolve the same configurable agent root without importing Pi's full entry point. */
export function resolveAgentDir(
	environment: Readonly<Record<string, string | undefined>> = process.env,
	homeDirectory: string = homedir(),
): string {
	const configured = environment[AGENT_DIR_ENV];
	if (!configured) return path.join(homeDirectory, DEFAULT_CONFIG_DIR, DEFAULT_AGENT_DIR);
	if (configured === "~") return homeDirectory;
	if (configured.startsWith(TILDE_PREFIX)) {
		return path.join(homeDirectory, configured.slice(TILDE_PREFIX.length));
	}
	if (configured.startsWith(FILE_URL_PREFIX)) return fileURLToPath(configured);
	return configured;
}

/** Preserve Pi's familiar key labels while depending only on pi-tui keybindings. */
export function formatKeyText(key: string, platform: NodeJS.Platform = process.platform): string {
	return key
		.split("/")
		.map((binding) =>
			binding
				.split("+")
				.map((part) =>
					platform === "darwin" && part.toLowerCase() === MAC_ALT_KEY ? MAC_ALT_LABEL : part,
				)
				.join("+"),
		)
		.join("/");
}

export function keyText(keybinding: Keybinding): string {
	return getKeybindings()
		.getKeys(keybinding)
		.map((key) => formatKeyText(key))
		.join("/");
}

/** Local border avoids loading Pi's aggregate SDK entry point for one TUI primitive. */
export class StashBorder implements Component {
	private readonly color: (text: string) => string;

	constructor(color: (text: string) => string) {
		this.color = color;
	}

	render(width: number): string[] {
		return [this.color("─".repeat(Math.max(1, width)))];
	}

	invalidate(): void {
		// No cache: method exists only to satisfy the TUI component lifecycle.
	}
}
