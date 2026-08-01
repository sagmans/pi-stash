// Minimal structural contract with Pi. Pi injects this API when loading the extension;
// importing the full host package would duplicate Pi and its complete provider stack.

import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	type Component,
	getKeybindings,
	type Keybinding,
	type KeybindingsManager,
	type KeyId,
} from "@earendil-works/pi-tui";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const DEFAULT_CONFIG_DIR = ".pi";
const DEFAULT_AGENT_DIR = "agent";
const TILDE_PREFIX = "~/";
const FILE_URL_PREFIX = "file://";
const MAC_ALT_KEY = "alt";
const MAC_ALT_LABEL = "option";
const SHORTCUT_MODIFIERS = ["ctrl", "shift", "alt"] as const;
const SHORTCUT_NAMED_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageUp",
	"pageDown",
	"up",
	"down",
	"left",
	"right",
]);
const SHORTCUT_SYMBOL_KEYS = new Set([
	"`",
	"-",
	"=",
	"[",
	"]",
	"\\",
	";",
	"'",
	",",
	".",
	"/",
	"!",
	"@",
	"#",
	"$",
	"%",
	"^",
	"&",
	"*",
	"(",
	")",
	"_",
	"+",
	"|",
	"~",
	"{",
	"}",
	":",
	"<",
	">",
	"?",
]);
const SHORTCUT_FUNCTION_KEY_PATTERN = /^f(?:[1-9]|1[0-2])$/u;
const SHORTCUT_LETTER_PATTERN = /^[a-z]$/u;
const SHORTCUT_DIGIT_PATTERN = /^\d$/u;
const SHORTCUT_KEY_ALIASES: Readonly<Record<string, string>> = {
	esc: "escape",
	return: "enter",
};

export type ParsedShortcut = {
	key: KeyId;
	identity: string;
};

export type Theme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

export type StashKeybindings = Pick<KeybindingsManager, "getKeys" | "matches">;

export type StashOverlayTui = {
	requestRender(): void;
};

export type StashWidgetFactory = (
	tui: unknown,
	theme: Pick<Theme, "fg">,
) => { render(width: number): string[]; invalidate(): void };

export type PiUi = {
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
			keybindings: StashKeybindings,
			done: (value: T | undefined) => void,
		) => unknown,
		options?: { overlay?: boolean; overlayOptions?: unknown },
	): Promise<T | undefined>;
};

export type PiSessionContext = {
	cwd: string;
	/** Present under pi (only "tui" is interactive); omp's context omits it. */
	mode?: string;
	hasUI: boolean;
	ui: PiUi;
};

export type ExtensionAPI = {
	on(event: string, handler: (event: unknown, context: PiSessionContext) => unknown): void;
	registerCommand(
		name: string,
		command: {
			description: string;
			handler(args: unknown, context: PiSessionContext): unknown;
		},
	): void;
	registerShortcut(
		shortcut: KeyId,
		definition: {
			description: string;
			handler(context: PiSessionContext): unknown;
		},
	): void;
	getCommands(): readonly {
		name: string;
		source: string;
		sourceInfo: { path: string };
	}[];
};

function splitShortcut(value: string): { modifiers: string[]; key: string } | undefined {
	if (value === "+") return { modifiers: [], key: value };
	const hasPlusKey = value.endsWith("++");
	const prefix = hasPlusKey ? value.slice(0, -2) : value;
	const parts = prefix.split("+");
	const key = hasPlusKey ? "+" : parts.pop();
	if (!key || parts.some((part) => part.length === 0)) return undefined;
	return { modifiers: parts, key };
}

function isShortcutKey(value: string): boolean {
	return (
		SHORTCUT_LETTER_PATTERN.test(value) ||
		SHORTCUT_DIGIT_PATTERN.test(value) ||
		SHORTCUT_NAMED_KEYS.has(value) ||
		SHORTCUT_SYMBOL_KEYS.has(value) ||
		SHORTCUT_FUNCTION_KEY_PATTERN.test(value)
	);
}

/** Keep config validation aligned with Pi's key grammar and physical-key aliases. */
export function parseShortcut(value: unknown): ParsedShortcut | undefined {
	if (typeof value !== "string") return undefined;
	const key = value.trim();
	const parts = splitShortcut(key);
	if (!parts || !isShortcutKey(parts.key)) return undefined;
	const modifiers = new Set(parts.modifiers);
	if (
		modifiers.size !== parts.modifiers.length ||
		parts.modifiers.some(
			(modifier) => !SHORTCUT_MODIFIERS.includes(modifier as (typeof SHORTCUT_MODIFIERS)[number]),
		)
	) {
		return undefined;
	}
	const canonicalKey = SHORTCUT_KEY_ALIASES[parts.key] ?? parts.key.toLowerCase();
	if (
		modifiers.size > 0 &&
		(canonicalKey === "escape" || SHORTCUT_FUNCTION_KEY_PATTERN.test(canonicalKey))
	) {
		return undefined;
	}
	const canonicalModifiers = SHORTCUT_MODIFIERS.filter((modifier) => modifiers.has(modifier));
	return {
		key: key as KeyId,
		identity: [...canonicalModifiers, canonicalKey].join("+"),
	};
}

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

export function keyText(
	keybinding: Keybinding,
	keybindings: StashKeybindings = getKeybindings(),
): string {
	return keybindings
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
		return [this.color("─".repeat(Math.max(0, width)))];
	}

	invalidate(): void {
		// No cache: method exists only to satisfy the TUI component lifecycle.
	}
}
