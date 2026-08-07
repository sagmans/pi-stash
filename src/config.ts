// Strict shortcut configuration: the package ships its own config.json as the
// default, and a user override file under the Pi agent directory replaces it.
// No key values are hardcoded here; every binding comes from a config file.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type ParsedShortcut, parseShortcut, resolveAgentDir } from "./host.ts";
import { assertPrivateDirectory, hasErrorCode, readPrivateTextFile } from "./private-fs.ts";
import { isRecord } from "./types.ts";

const CONFIG_DIRECTORY_NAME = "pi-stash";
const CONFIG_FILE_NAME = "config.json";
const CONFIG_LABEL = "pi-stash config";
const CONFIG_MAX_BYTES = 64 * 1024;
const ROOT_FIELDS = new Set(["keybindings"]);
const KEYBINDING_FIELDS = new Set(["stash", "list"]);
const SHIPPED_CONFIG_PATH = fileURLToPath(new URL("../config.json", import.meta.url));

export type StashConfig = {
	readonly keybindings: {
		readonly stash: ParsedShortcut["key"];
		readonly list: ParsedShortcut["key"];
	};
};

/** Defaults shipped with the package; the user config.json overrides them. */
export const SHIPPED_STASH_CONFIG: StashConfig = Object.freeze({
	keybindings: Object.freeze(loadShippedConfig().keybindings),
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

function requiredShortcut(value: unknown, field: string): ParsedShortcut {
	const shortcut = parseShortcut(value);
	if (!shortcut) throw invalidConfig(`${field} must be a valid Pi shortcut`);
	return shortcut;
}

function configuredShortcut(value: unknown, fallback: string, field: string): ParsedShortcut {
	const shortcut = parseShortcut(value === undefined ? fallback : value);
	if (!shortcut) throw invalidConfig(`${field} must be a valid Pi shortcut`);
	return shortcut;
}

/** The shipped file is complete: every field must be present and valid. */
function parseShippedConfig(value: unknown): StashConfig {
	if (!isRecord(value)) throw invalidConfig("shipped config root must be an object");
	assertKnownFields(value, ROOT_FIELDS);
	if (!isRecord(value.keybindings)) {
		throw invalidConfig("shipped keybindings must be an object");
	}
	assertKnownFields(value.keybindings, KEYBINDING_FIELDS);
	const stash = requiredShortcut(value.keybindings.stash, "keybindings.stash");
	const list = requiredShortcut(value.keybindings.list, "keybindings.list");
	if (stash.identity === list.identity) throw invalidConfig("stash and list shortcuts must differ");
	return { keybindings: { stash: stash.key, list: list.key } };
}

/** The user file is partial: omitted fields fall back to the shipped config. */
function parseUserConfig(value: unknown, defaults: StashConfig): StashConfig {
	if (!isRecord(value)) throw invalidConfig("root must be an object");
	assertKnownFields(value, ROOT_FIELDS);
	const keybindings = value.keybindings === undefined ? {} : value.keybindings;
	if (!isRecord(keybindings)) throw invalidConfig("keybindings must be an object");
	assertKnownFields(keybindings, KEYBINDING_FIELDS);
	const stash = configuredShortcut(
		keybindings.stash,
		defaults.keybindings.stash,
		"keybindings.stash",
	);
	const list = configuredShortcut(keybindings.list, defaults.keybindings.list, "keybindings.list");
	if (stash.identity === list.identity) throw invalidConfig("stash and list shortcuts must differ");
	return { keybindings: { stash: stash.key, list: list.key } };
}

function loadShippedConfig(): StashConfig {
	const text = readFileSync(SHIPPED_CONFIG_PATH, "utf8");
	if (text.length > CONFIG_MAX_BYTES) {
		throw invalidConfig(`shipped ${CONFIG_FILE_NAME} is too large`);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw invalidConfig(`shipped ${CONFIG_FILE_NAME} must contain valid JSON`, error);
	}
	return parseShippedConfig(value);
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
			return { keybindings: { ...SHIPPED_STASH_CONFIG.keybindings } };
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
	return parseUserConfig(value, SHIPPED_STASH_CONFIG);
}
