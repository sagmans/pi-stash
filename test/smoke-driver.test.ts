import { strict as assert } from "node:assert";
import test from "node:test";

import installSmokeDriver from "../scripts/smoke/driver.ts";

const EXPECTED_EXTENSION = "/tmp/pi-stash-package/index.ts";
const IMAGE_PATH = "/tmp/pi-clipboard-00000000-0000-4000-8000-000000000001.png";
const CANARY = "PI_STASH_SMOKE_DRAFT_7E4A9C2D";

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

function withSmokeEnvironment(phase: "stash" | "restore", run: () => Promise<void>): Promise<void> {
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

function createPi(commandPath = EXPECTED_EXTENSION) {
	const events = new FakeEvents();
	const handlers = new Map<string, SessionHandler>();
	const pi = {
		events,
		getCommands: () => [
			{
				name: "stash",
				source: "extension",
				sourceInfo: { path: commandPath },
			},
			{
				name: "stash-pop",
				source: "extension",
				sourceInfo: { path: commandPath },
			},
		],
		on: (name: string, handler: SessionHandler) => {
			handlers.set(name, handler);
		},
	};
	installSmokeDriver(pi as never);
	return { events, handlers };
}

test("smoke driver seeds a synthetic draft through the packaged extension binding", async () => {
	await withSmokeEnvironment("stash", async () => {
		const { events, handlers } = createPi();
		let available: unknown;
		events.on("prefix-keybindings:available", (payload) => {
			available = payload;
		});
		events.emit("prefix-keybindings:query");
		assert.deepEqual(available, { available: true, prefixKey: "smoke" });

		let action: { eventId: string; key: string; requester: string } | undefined;
		events.on("prefix-keybindings:register", (payload) => {
			const claim = payload as typeof action;
			if (claim?.key === "s") action = claim;
		});
		events.emit("prefix-keybindings:register", {
			requester: "package-instance",
			key: "s",
			eventId: "package-instance:stash",
		});

		let editor = "";
		let firedDraft = "";
		const notifications: string[] = [];
		events.on("package-instance:stash", () => {
			firedDraft = editor;
			editor = "";
		});
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

		assert.ok(action);
		assert.equal(firedDraft, `Synthetic smoke draft\n${CANARY}\n${IMAGE_PATH}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepEqual(notifications, ["PI_STASH_SMOKE_STASHED"]);
	});
});

test("smoke driver fails closed when commands do not come from the packaged entry point", async () => {
	await withSmokeEnvironment("restore", async () => {
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
