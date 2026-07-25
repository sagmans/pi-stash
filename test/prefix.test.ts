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

function claim(key: string, eventId: string, fired: string[]) {
	return { key, eventId, onFire: () => fired.push(key) };
}

const REQUESTER = "@sagmans/pi-stash:test-instance";

function start(
	bus: ReturnType<typeof createBus>,
	claims: ReturnType<typeof claim>[],
	overrides: Partial<Parameters<typeof startStashBinding>[0]> = {},
) {
	const scheduler = createScheduler();
	const cleanup = startStashBinding({
		events: bus,
		requester: REQUESTER,
		claims,
		onInert: () => {},
		schedule: scheduler.schedule,
		...overrides,
	});
	return { cleanup, scheduler };
}

test("queries prefix-keybindings with the namespaced instance identity", () => {
	const bus = createBus();
	const { cleanup } = start(bus, []);

	assert.deepEqual(bus.emitted[0], {
		event: "prefix-keybindings:query",
		payload: { requester: REQUESTER },
	});
	cleanup();
});

test("registers namespaced claims and reports the effective prefix", () => {
	const bus = createBus();
	const fired: string[] = [];
	const prefixes: string[] = [];
	const { cleanup, scheduler } = start(
		bus,
		[claim("s", `${REQUESTER}:stash`, fired), claim("S", `${REQUESTER}:list`, fired)],
		{ onActive: (prefixKey) => prefixes.push(prefixKey) },
	);

	bus.emit("prefix-keybindings:available", { available: true, prefixKey: "ctrl+x" });

	const registers = bus.emitted.filter((entry) => entry.event === "prefix-keybindings:register");
	assert.deepEqual(
		registers.map((entry) => entry.payload),
		[
			{ requester: REQUESTER, key: "s", eventId: `${REQUESTER}:stash` },
			{ requester: REQUESTER, key: "S", eventId: `${REQUESTER}:list` },
		],
	);
	assert.deepEqual(prefixes, ["ctrl+x"]);
	assert.equal(scheduler.pending, false);
	cleanup();
});

test("fires only the action owned by this instance and key", () => {
	const bus = createBus();
	const fired: string[] = [];
	const { cleanup } = start(bus, [claim("s", `${REQUESTER}:stash`, fired)]);
	bus.emit("prefix-keybindings:available", { available: true, prefixKey: "ctrl+x" });

	bus.emit(`${REQUESTER}:stash`, { requester: "other-extension", key: "s" });
	bus.emit(`${REQUESTER}:stash`, { requester: REQUESTER, key: "S" });
	bus.emit(`${REQUESTER}:stash`, { requester: REQUESTER, key: "s" });

	assert.deepEqual(fired, ["s"]);
	cleanup();
});

test("duplicate instances dispatch only the registry owner", () => {
	const bus = createBus();
	const firstFired: string[] = [];
	const secondFired: string[] = [];
	const firstRequester = "@sagmans/pi-stash:first";
	const secondRequester = "@sagmans/pi-stash:second";
	const first = start(bus, [claim("s", `${firstRequester}:stash`, firstFired)], {
		requester: firstRequester,
	});
	const second = start(bus, [claim("s", `${secondRequester}:stash`, secondFired)], {
		requester: secondRequester,
	});
	bus.emit("prefix-keybindings:available", { available: true, prefixKey: "ctrl+x" });
	const owner = bus.emitted.find(
		(entry) =>
			entry.event === "prefix-keybindings:register" &&
			(entry.payload as { key?: string }).key === "s",
	)?.payload as { requester: string; key: string; eventId: string };

	bus.emit(owner.eventId, { requester: owner.requester, key: owner.key });

	assert.deepEqual(firstFired, ["s"]);
	assert.deepEqual(secondFired, []);
	first.cleanup();
	second.cleanup();
});

test("reload detaches old callbacks and accepts a changed prefix", () => {
	const bus = createBus();
	const fired: string[] = [];
	const prefixes: string[] = [];
	const old = start(bus, [claim("s", `${REQUESTER}:old`, fired)], {
		onActive: (prefixKey) => prefixes.push(prefixKey),
	});
	bus.emit("prefix-keybindings:available", { available: true, prefixKey: "ctrl+x" });
	old.cleanup();

	const replacement = start(bus, [claim("s", `${REQUESTER}:new`, fired)], {
		onActive: (prefixKey) => prefixes.push(prefixKey),
	});
	bus.emit("prefix-keybindings:available", { available: true, prefixKey: "alt+p" });
	bus.emit(`${REQUESTER}:old`, { requester: REQUESTER, key: "s" });
	bus.emit(`${REQUESTER}:new`, { requester: REQUESTER, key: "s" });

	assert.deepEqual(prefixes, ["ctrl+x", "alt+p"]);
	assert.deepEqual(fired, ["s"]);
	replacement.cleanup();
});

test("ignores malformed and competing availability announcements after activation", () => {
	const bus = createBus();
	const prefixes: string[] = [];
	const { cleanup } = start(bus, [], {
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
		claims: [],
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
		claims: [claim("s", `${REQUESTER}:stash`, fired)],
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
