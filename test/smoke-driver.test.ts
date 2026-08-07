import { strict as assert } from "node:assert";
import test from "node:test";

import installSmokeDriver from "../scripts/smoke/driver.ts";

const EXPECTED_EXTENSION = "/tmp/pi-stash-package/index.ts";
const IMAGE_PATH = "/tmp/pi-clipboard-00000000-0000-4000-8000-000000000001.png";
const CANARY = "PI_STASH_SMOKE_DRAFT_7E4A9C2D";
const STASH_READY_MARKER = "PI_STASH_SMOKE_STASH_READY";
const CLEANUP_READY_MARKER = "PI_STASH_SMOKE_CLEANUP_READY";
const RETIRED_COMMAND_NAME = "stash-restore";
const EXPECTED_COMMAND_NAMES = [
	"stash",
	"stash-pop",
	"stash-list",
	"stash-drop",
	"stash-apply",
	"stash-clear",
	"stash-migrate",
	"stash-cleanup-images",
] as const;

type Listener = (payload?: unknown) => void;
type SessionHandler = (event: unknown, context: unknown) => void | Promise<void>;

class FakeEvents {
	readonly listeners = new Map<string, Set<Listener>>();

	on(name: string, listener: Listener): () => void {
		const listeners = this.listeners.get(name) ?? new Set<Listener>();
		listeners.add(listener);
		this.listeners.set(name, listeners);
		return () => listeners.delete(listener);
	}

	emit(name: string, payload?: unknown): void {
		for (const listener of this.listeners.get(name) ?? []) listener(payload);
	}
}

function withSmokeEnvironment(phase: "stash" | "pop", run: () => Promise<void>): Promise<void> {
	const original = { ...process.env };
	Object.assign(process.env, {
		PI_STASH_SMOKE_PHASE: phase,
		PI_STASH_SMOKE_EXTENSION: EXPECTED_EXTENSION,
		PI_STASH_SMOKE_IMAGE: IMAGE_PATH,
		PI_STASH_SMOKE_CANARY: CANARY,
	});
	return run().finally(() => {
		for (const name of Object.keys(process.env)) {
			if (!(name in original)) delete process.env[name];
		}
		Object.assign(process.env, original);
	});
}

function createPi(
	commandPath = EXPECTED_EXTENSION,
	commandNames: readonly string[] = EXPECTED_COMMAND_NAMES,
) {
	const events = new FakeEvents();
	const handlers = new Map<string, SessionHandler>();
	const pi = {
		events,
		getCommands: () =>
			commandNames.map((name) => ({
				name,
				source: "extension",
				sourceInfo: { path: commandPath },
			})),
		on: (name: string, handler: SessionHandler) => {
			handlers.set(name, handler);
		},
	};
	installSmokeDriver(pi as never);
	return { events, handlers };
}

test("smoke driver seeds a synthetic draft for native shortcut dispatch", async () => {
	await withSmokeEnvironment("stash", async () => {
		const { handlers } = createPi();
		let editor = "";
		const notifications: string[] = [];
		await handlers.get("session_start")?.(
			{},
			{
				mode: "tui",
				hasUI: true,
				ui: {
					getEditorText: () => editor,
					setEditorText: (text: string) => {
						editor = text;
					},
					notify: (message: string) => notifications.push(message),
				},
			},
		);

		assert.equal(editor, `Synthetic smoke draft\n${CANARY}\n${IMAGE_PATH}`);
		assert.deepEqual(notifications, [STASH_READY_MARKER]);
		editor = "";
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepEqual(notifications, [STASH_READY_MARKER, "PI_STASH_SMOKE_STASHED"]);
	});
});

test("smoke driver clears the popped editor before packaged image cleanup", async () => {
	await withSmokeEnvironment("pop", async () => {
		const { handlers } = createPi();
		let editor = "";
		const notifications: string[] = [];
		await handlers.get("session_start")?.(
			{},
			{
				mode: "tui",
				hasUI: true,
				ui: {
					getEditorText: () => editor,
					setEditorText: (text: string) => {
						editor = text;
					},
					notify: (message: string) => notifications.push(message),
				},
			},
		);

		editor = `Synthetic smoke draft\n${CANARY}\n${IMAGE_PATH}`;
		await new Promise((resolve) => setTimeout(resolve, 50));

		assert.equal(editor, "");
		assert.ok(notifications.includes(CLEANUP_READY_MARKER));
	});
});

test("smoke driver fails closed when commands do not come from the packaged entry point", async () => {
	await withSmokeEnvironment("pop", async () => {
		const { handlers } = createPi("/tmp/checkout/index.ts");
		const notifications: string[] = [];
		await handlers.get("session_start")?.(
			{},
			{
				mode: "tui",
				hasUI: true,
				ui: {
					getEditorText: () => "",
					setEditorText: () => {},
					notify: (message: string) => notifications.push(message),
				},
			},
		);

		assert.deepEqual(notifications, ["PI_STASH_SMOKE_FAILED"]);
	});
});

test("smoke driver rejects retired packaged commands outside the exact surface", async () => {
	await withSmokeEnvironment("pop", async () => {
		const { handlers } = createPi(EXPECTED_EXTENSION, [
			...EXPECTED_COMMAND_NAMES,
			RETIRED_COMMAND_NAME,
		]);
		const notifications: string[] = [];
		await handlers.get("session_start")?.(
			{},
			{
				mode: "tui",
				hasUI: true,
				ui: {
					getEditorText: () => "",
					setEditorText: () => {},
					notify: (message: string) => notifications.push(message),
				},
			},
		);

		assert.deepEqual(notifications, ["PI_STASH_SMOKE_FAILED"]);
	});
});
