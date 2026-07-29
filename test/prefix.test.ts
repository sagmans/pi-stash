import { strict as assert } from "node:assert";
import test from "node:test";

import { startStashBinding } from "../src/prefix.ts";

type Handler = (payload?: unknown) => void;

function createBus() {
	const handlers = new Map<string, Set<Handler>>();
	const emitted: Array<{ event: string; payload?: unknown }> = [];
	return {
		emit(event: string, payload?: unknown) {
			emitted.push({ event, payload });
			handlers.get(event)?.forEach((handler) => {
				handler(payload);
			});
		},
		on(event: string, handler: Handler) {
			const set = handlers.get(event) ?? new Set();
			set.add(handler);
			handlers.set(event, set);
			return () => set.delete(handler);
		},
		emitted,
	};
}

function createScheduler() {
	let pending: (() => void) | undefined;
	return {
		schedule(fn: () => void) {
			pending = fn;
			return () => {
				if (pending === fn) pending = undefined;
			};
		},
		fire() {
			const task = pending;
			pending = undefined;
			task?.();
		},
		get pending() {
			return pending !== undefined;
		},
	};
}

const REQUESTER = "@sagmans/pi-stash:test-instance";

function start(
	bus: ReturnType<typeof createBus>,
	overrides: Partial<Parameters<typeof startStashBinding>[0]> = {},
) {
	const scheduler = createScheduler();
	const cleanup = startStashBinding({
		events: bus,
		requester: REQUESTER,
		onStash: () => {},
		onList: () => {},
		onInert: () => {},
		schedule: scheduler.schedule,
		...overrides,
	});
	return { cleanup, scheduler };
}

test("queries prefix-keybindings with the namespaced instance identity", () => {
	const bus = createBus();
	const { cleanup } = start(bus);

	assert.deepEqual(bus.emitted[0], {
		event: "prefix-keybindings:query",
		payload: { requester: REQUESTER },
	});
	cleanup();
});

test("registers fixed namespaced actions and reports the effective prefix", () => {
	const bus = createBus();
	const prefixes: string[] = [];
	const { cleanup, scheduler } = start(bus, {
		onActive: (prefixKey) => prefixes.push(prefixKey),
	});

	bus.emit("prefix-keybindings:available", { available: true, prefixKey: "ctrl+x" });

	assert.deepEqual(
		bus.emitted
			.filter((entry) => entry.event === "prefix-keybindings:register")
			.map((entry) => entry.payload),
		[
			{ requester: REQUESTER, key: "s", eventId: `${REQUESTER}:stash` },
			{ requester: REQUESTER, key: "S", eventId: `${REQUESTER}:list` },
		],
	);
	assert.deepEqual(prefixes, ["ctrl+x"]);
	assert.equal(scheduler.pending, false);
	cleanup();
});

test("fires only actions owned by this instance and key", () => {
	const bus = createBus();
	const fired: string[] = [];
	const { cleanup } = start(bus, {
		onStash: () => fired.push("stash"),
		onList: () => fired.push("list"),
	});
	bus.emit("prefix-keybindings:available", { available: true, prefixKey: "ctrl+x" });

	bus.emit(`${REQUESTER}:stash`, { requester: "other-extension", key: "s" });
	bus.emit(`${REQUESTER}:stash`, { requester: REQUESTER, key: "S" });
	bus.emit(`${REQUESTER}:stash`, { requester: REQUESTER, key: "s" });
	bus.emit(`${REQUESTER}:list`, { requester: REQUESTER, key: "S" });

	assert.deepEqual(fired, ["stash", "list"]);
	cleanup();
});

test("duplicate instances dispatch only the registry owner", () => {
	const bus = createBus();
	const firstFired: string[] = [];
	const secondFired: string[] = [];
	const firstRequester = "@sagmans/pi-stash:first";
	const secondRequester = "@sagmans/pi-stash:second";
	const first = start(bus, {
		requester: firstRequester,
		onStash: () => firstFired.push("stash"),
	});
	const second = start(bus, {
		requester: secondRequester,
		onStash: () => secondFired.push("stash"),
	});
	bus.emit("prefix-keybindings:available", { available: true, prefixKey: "ctrl+x" });
	const owner = bus.emitted.find(
		(entry) =>
			entry.event === "prefix-keybindings:register" &&
			(entry.payload as { key?: string }).key === "s",
	)?.payload as { requester: string; key: string; eventId: string };

	bus.emit(owner.eventId, { requester: owner.requester, key: owner.key });

	assert.deepEqual(firstFired, ["stash"]);
	assert.deepEqual(secondFired, []);
	first.cleanup();
	second.cleanup();
});

test("reload detaches old callbacks and accepts a changed prefix", () => {
	const bus = createBus();
	const fired: string[] = [];
	const prefixes: string[] = [];
	const old = start(bus, {
		onStash: () => fired.push("old"),
		onActive: (prefixKey) => prefixes.push(prefixKey),
	});
	bus.emit("prefix-keybindings:available", { available: true, prefixKey: "ctrl+x" });
	old.cleanup();

	const replacement = start(bus, {
		onStash: () => fired.push("new"),
		onActive: (prefixKey) => prefixes.push(prefixKey),
	});
	bus.emit("prefix-keybindings:available", { available: true, prefixKey: "alt+p" });
	bus.emit(`${REQUESTER}:stash`, { requester: REQUESTER, key: "s" });

	assert.deepEqual(prefixes, ["ctrl+x", "alt+p"]);
	assert.deepEqual(fired, ["new"]);
	replacement.cleanup();
});

test("ignores malformed and competing availability announcements after activation", () => {
	const bus = createBus();
	const prefixes: string[] = [];
	const { cleanup } = start(bus, {
		onActive: (prefixKey) => prefixes.push(prefixKey),
	});

	bus.emit("prefix-keybindings:available", { available: true });
	bus.emit("prefix-keybindings:available", { available: true, prefixKey: "ctrl+x" });
	bus.emit("prefix-keybindings:available", { available: true, prefixKey: "alt+p" });

	assert.deepEqual(prefixes, ["ctrl+x"]);
	cleanup();
});

test("goes inert when the binding provider is disabled", () => {
	const bus = createBus();
	const scheduler = createScheduler();
	let inert = 0;
	const cleanup = startStashBinding({
		events: bus,
		requester: REQUESTER,
		onStash: () => {},
		onList: () => {},
		onInert: () => {
			inert += 1;
		},
		schedule: scheduler.schedule,
	});

	scheduler.fire();
	bus.emit("prefix-keybindings:available", { available: true, prefixKey: "ctrl+x" });

	assert.equal(inert, 1);
	assert.equal(
		bus.emitted.some((entry) => entry.event === "prefix-keybindings:register"),
		false,
	);
	cleanup();
});

test("cleanup cancels timeout, listeners, and callbacks", () => {
	const bus = createBus();
	const fired: string[] = [];
	const scheduler = createScheduler();
	let inert = 0;
	const cleanup = startStashBinding({
		events: bus,
		requester: REQUESTER,
		onStash: () => fired.push("stash"),
		onList: () => fired.push("list"),
		onInert: () => {
			inert += 1;
		},
		schedule: scheduler.schedule,
	});

	cleanup();
	scheduler.fire();
	bus.emit("prefix-keybindings:available", { available: true, prefixKey: "ctrl+x" });
	bus.emit(`${REQUESTER}:stash`, { requester: REQUESTER, key: "s" });

	assert.equal(scheduler.pending, false);
	assert.equal(inert, 0);
	assert.deepEqual(fired, []);
});
