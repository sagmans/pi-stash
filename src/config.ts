// Strict native-shortcut configuration loaded before extension registration.

import path from "node:path";

import { type ParsedShortcut, parseShortcut, resolveAgentDir } from "./host.ts";
import { assertPrivateDirectory, hasErrorCode, readPrivateTextFile } from "./private-fs.ts";
import { isRecord } from "./types.ts";

const CONFIG_DIRECTORY_NAME = "pi-stash";
const CONFIG_FILE_NAME = "config.json";
const CONFIG_LABEL = "pi-stash config";
const CONFIG_MAX_BYTES = 64 * 1024;
const ROOT_FIELDS = new Set(["keybindings"]);
const KEYBINDING_FIELDS = new Set(["stash", "list"]);

export const DEFAULT_STASH_SHORTCUT = "ctrl+shift+h";
export const DEFAULT_LIST_SHORTCUT = "ctrl+shift+r";

export type StashConfig = {
	readonly keybindings: {
		readonly stash: ParsedShortcut["key"];
		readonly list: ParsedShortcut["key"];
	};
};

export const DEFAULT_STASH_CONFIG: StashConfig = Object.freeze({
	keybindings: Object.freeze({
		stash: DEFAULT_STASH_SHORTCUT,
		list: DEFAULT_LIST_SHORTCUT,
	}),
});

function invalidConfig(reason: string, cause?: unknown): Error {
	return new Error(
		`invalid ${CONFIG_LABEL}: ${reason}`,
		cause === undefined ? undefined : { cause },
	);
}

function assertKnownFields(value: Record<string, unknown>, fields: ReadonlySet<string>): void {
	if (Object.keys(value).some((field) => !fields.has(field))) {
		throw invalidConfig("contains an unknown field");
	}
}

function configuredShortcut(value: unknown, fallback: string, field: string): ParsedShortcut {
	const shortcut = parseShortcut(value === undefined ? fallback : value);
	if (!shortcut) throw invalidConfig(`${field} must be a valid Pi shortcut`);
	return shortcut;
}

function parseConfig(value: unknown): StashConfig {
	if (!isRecord(value)) throw invalidConfig("root must be an object");
	assertKnownFields(value, ROOT_FIELDS);
	const keybindings = value.keybindings === undefined ? {} : value.keybindings;
	if (!isRecord(keybindings)) throw invalidConfig("keybindings must be an object");
	assertKnownFields(keybindings, KEYBINDING_FIELDS);
	const stash = configuredShortcut(keybindings.stash, DEFAULT_STASH_SHORTCUT, "keybindings.stash");
	const list = configuredShortcut(keybindings.list, DEFAULT_LIST_SHORTCUT, "keybindings.list");
	if (stash.identity === list.identity) throw invalidConfig("stash and list shortcuts must differ");
	return { keybindings: { stash: stash.key, list: list.key } };
}

export function resolveStashConfigPath(agentDir: string = resolveAgentDir()): string {
	return path.join(agentDir, CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME);
}

export async function loadStashConfig(
	configPath: string = resolveStashConfigPath(),
): Promise<StashConfig> {
	let text: string;
	try {
		await assertPrivateDirectory(path.dirname(configPath), `${CONFIG_LABEL} directory`);
		text = (await readPrivateTextFile(configPath, CONFIG_LABEL, CONFIG_MAX_BYTES)).text;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return { keybindings: { ...DEFAULT_STASH_CONFIG.keybindings } };
		}
		if (error instanceof Error && error.message.startsWith(`invalid ${CONFIG_LABEL}:`)) throw error;
		throw invalidConfig(error instanceof Error ? error.message : "unknown read failure", error);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw invalidConfig("file must contain valid JSON", error);
	}
	return parseConfig(value);
}
