import { strict as assert } from "node:assert";
import test from "node:test";

import { startStashBinding } from "../src/prefix.ts";

type Handler = (payload?: unknown) => void;

function createBus() {
	const handlers = new Map<string, Set<Handler>>();
	const emitted: Array<{ event: string; payload?: unknown }> = [];
	const bus = {
		emit(event: string, payload?: unknown) {
			emitted.push({ event, payload });
			handlers.get(event)?.forEach((handler) => {
				handler(payload);
			});
		},
		on(event: string, handler: Handler) {
			let set = handlers.get(event);
			if (!set) {
				set = new Set();
				handlers.set(event, set);
			}
			set.add(handler);
			const activeSet = set;
			return () => {
				activeSet.delete(handler);
			};
		},
		emitted,
	};
	return bus;
}

function claim(key: string, eventId: string, fired: string[]) {
	return { key, eventId, onFire: () => fired.push(key) };
}

test("emits a query on start to discover prefix-keybindings", () => {
	const bus = createBus();
	startStashBinding({
		events: bus,
		claims: [],
		onInert: () => {},
		availabilityTimeoutMs: 1000,
	});
	assert.ok(bus.emitted.some((entry) => entry.event === "prefix-keybindings:query"));
});

test("registers every claim when prefix-keybindings becomes available", () => {
	const bus = createBus();
	const fired: string[] = [];
	startStashBinding({
		events: bus,
		claims: [claim("s", "pi-stash:stash", fired), claim("S", "pi-stash:list", fired)],
		onInert: () => {},
		availabilityTimeoutMs: 1000,
	});

	bus.emit("prefix-keybindings:available", { available: true });

	const registers = bus.emitted.filter((entry) => entry.event === "prefix-keybindings:register");
	assert.equal(registers.length, 2);
	assert.deepEqual(registers.map((entry) => (entry.payload as { key: string }).key).sort(), [
		"S",
		"s",
	]);
});

test("dispatching a claim's action event fires its callback", () => {
	const bus = createBus();
	const fired: string[] = [];
	startStashBinding({
		events: bus,
		claims: [claim("s", "pi-stash:stash", fired)],
		onInert: () => {},
		availabilityTimeoutMs: 1000,
	});

	bus.emit("prefix-keybindings:available", { available: true });
	bus.emit("pi-stash:stash", { requester: "pi-stash", key: "s" });

	assert.deepEqual(fired, ["s"]);
});

test("goes inert when availability times out and never registers later", async () => {
	const bus = createBus();
	const fired: string[] = [];
	let inert = false;
	startStashBinding({
		events: bus,
		claims: [claim("s", "pi-stash:stash", fired)],
		onInert: () => {
			inert = true;
		},
		// Injected fake scheduler: fire the timeout synchronously on demand.
		schedule: (fn) => {
			queueMicrotask(fn);
			return () => {};
		},
		availabilityTimeoutMs: 0,
	});

	// Let the microtask run so the inert window elapses before any announcement.
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(inert, true);

	bus.emit("prefix-keybindings:available", { available: true });
	assert.equal(
		bus.emitted.some((entry) => entry.event === "prefix-keybindings:register"),
		false,
	);
});

test("cleanup detaches listeners: late available and late action are no-ops", () => {
	const bus = createBus();
	const fired: string[] = [];
	const cleanup = startStashBinding({
		events: bus,
		claims: [claim("s", "pi-stash:stash", fired)],
		onInert: () => {},
		availabilityTimeoutMs: 1000,
	});

	cleanup();

	bus.emit("prefix-keybindings:available", { available: true });
	bus.emit("pi-stash:stash", {});
	assert.deepEqual(fired, []);
});
