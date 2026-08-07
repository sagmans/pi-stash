import { strict as assert } from "node:assert";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { matchesKey } from "@earendil-works/pi-tui";

import { loadStashConfig, resolveStashConfigPath, SHIPPED_STASH_CONFIG } from "../src/config.ts";

const EXPECTED_SHIPPED_SHORTCUTS = Object.freeze({
	stash: "ctrl+alt+s",
	list: "ctrl+alt+l",
});
const LEGACY_CTRL_ALT_S_SEQUENCE = "\x1b\x13";
const TERMINAL_ALT_BACKSPACE_SHORTCUT = "alt+backspace";

let agentDir: string;
let configDir: string;
let configPath: string;

beforeEach(() => {
	agentDir = mkdtempSync(path.join(tmpdir(), "pi-stash-config-"));
	configPath = resolveStashConfigPath(agentDir);
	configDir = path.dirname(configPath);
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

function writeConfig(value: unknown): void {
	mkdirSync(configDir, { recursive: true, mode: 0o700 });
	writeFileSync(configPath, JSON.stringify(value), { mode: 0o600 });
}

test("loadStashConfig defaults omitted fields independently", async () => {
	assert.deepEqual(SHIPPED_STASH_CONFIG.keybindings, EXPECTED_SHIPPED_SHORTCUTS);
	assert.deepEqual(await loadStashConfig(configPath), SHIPPED_STASH_CONFIG);

	writeConfig({});
	assert.deepEqual(await loadStashConfig(configPath), SHIPPED_STASH_CONFIG);

	writeConfig({ keybindings: { list: "alt+l" } });
	assert.deepEqual(await loadStashConfig(configPath), {
		keybindings: {
			stash: SHIPPED_STASH_CONFIG.keybindings.stash,
			list: "alt+l",
		},
	});
	assert.equal(Object.isFrozen(SHIPPED_STASH_CONFIG), true);
	assert.equal(Object.isFrozen(SHIPPED_STASH_CONFIG.keybindings), true);
});

test("default stash shortcut does not alias terminal Alt+Backspace", () => {
	assert.equal(
		matchesKey(LEGACY_CTRL_ALT_S_SEQUENCE, SHIPPED_STASH_CONFIG.keybindings.stash),
		true,
	);
	assert.equal(matchesKey(LEGACY_CTRL_ALT_S_SEQUENCE, TERMINAL_ALT_BACKSPACE_SHORTCUT), false);
});

test("loadStashConfig accepts Pi shortcut key families including literal plus", async () => {
	for (const shortcut of ["a", "escape", "f12", "ctrl+1", "+", "ctrl++", "shift+ctrl+s"]) {
		writeConfig({ keybindings: { stash: shortcut, list: "alt+l" } });
		assert.equal((await loadStashConfig(configPath)).keybindings.stash, shortcut, shortcut);
	}
});

test("loadStashConfig rejects malformed structures and shortcuts", async (context) => {
	mkdirSync(configDir);
	writeFileSync(configPath, "{ malformed", { mode: 0o600 });
	await assert.rejects(() => loadStashConfig(configPath), /invalid pi-stash config/iu);

	const cases: ReadonlyArray<[string, unknown]> = [
		["null root", null],
		["array root", []],
		["scalar root", "config"],
		["null keybindings", { keybindings: null }],
		["array keybindings", { keybindings: [] }],
		["non-string shortcut", { keybindings: { stash: 1 } }],
		["unknown root field", { extra: true }],
		["unknown keybinding field", { keybindings: { extra: "alt+x" } }],
		["invalid function key low", { keybindings: { stash: "f0" } }],
		["invalid function key high", { keybindings: { stash: "f13" } }],
		["repeated modifier", { keybindings: { stash: "ctrl+ctrl+s" } }],
		["modified escape", { keybindings: { stash: "ctrl+escape" } }],
		["modified function key", { keybindings: { stash: "shift+f1" } }],
		["unsupported prose", { keybindings: { stash: "control s" } }],
	];

	for (const [name, value] of cases) {
		await context.test(name, async () => {
			writeConfig(value);
			await assert.rejects(() => loadStashConfig(configPath), /invalid pi-stash config/iu);
		});
	}
});

test("loadStashConfig rejects physically equivalent action shortcuts", async (context) => {
	const cases: ReadonlyArray<[string, string]> = [
		["ctrl+shift+s", "shift+ctrl+s"],
		["esc", "escape"],
		["enter", "return"],
	];

	for (const [stash, list] of cases) {
		await context.test(`${stash} and ${list}`, async () => {
			writeConfig({ keybindings: { stash, list } });
			await assert.rejects(() => loadStashConfig(configPath), /shortcuts must differ/iu);
		});
	}
});

test("loadStashConfig repairs file mode and refuses unsafe config files", async (context) => {
	writeConfig({});
	chmodSync(configPath, 0o666);
	await loadStashConfig(configPath);
	assert.equal(statSync(configPath).mode & 0o777, 0o600);

	rmSync(configDir, { recursive: true, force: true });
	await context.test("config file symbolic link", async () => {
		const external = path.join(agentDir, "external.json");
		mkdirSync(configDir);
		writeFileSync(external, JSON.stringify({}), { mode: 0o600 });
		symlinkSync(external, configPath);

		await assert.rejects(() => loadStashConfig(configPath), /symbolic link/iu);
	});

	rmSync(configDir, { recursive: true, force: true });
	await context.test("config directory symbolic link", async () => {
		const external = path.join(agentDir, "external");
		mkdirSync(external);
		writeFileSync(path.join(external, "config.json"), JSON.stringify({}), { mode: 0o600 });
		symlinkSync(external, configDir);

		await assert.rejects(() => loadStashConfig(configPath), /symbolic link/iu);
	});
});

test("loadStashConfig rejects oversized input", async () => {
	mkdirSync(configDir);
	writeFileSync(configPath, `{"keybindings":{},"padding":"${"x".repeat(70_000)}"}`, {
		mode: 0o600,
	});
	await assert.rejects(() => loadStashConfig(configPath), /too large/iu);
});
