// Event-bus protocol that claims two prefix-key slots from prefix-keybindings:
//   prefix+s       -> stash the current editor draft
//   prefix+shift+s -> open the stash list overlay
//
// This module owns no SDK or terminal state: the event bus, the scheduler, and
// the action callbacks are all injected so the protocol is fully unit-testable
// without a real TUI. src/index.ts supplies the real SDK glue.
//
// Lifecycle:
//   session_start  -> emit `prefix-keybindings:query`
//                  -> on `prefix-keybindings:available` emit
//                     `prefix-keybindings:register { requester, key, eventId }`
//                     for each claimed key
//                  -> on the key's action event, invoke the matching callback
//   no `available` -> after the window, invoke `onInert` once and stay dormant
//   session_shutdown / cleanup -> detach every listener and cancel the timer
//
// A claim is rejected silently by prefix-keybindings when the key is already
// taken (built-in action, plannotator, preset, or another extension). In that
// case the action event never fires; the slash commands remain available as a
// reliable fallback.

const PREFIX_KEYBINDINGS_QUERY_EVENT = "prefix-keybindings:query";
const PREFIX_KEYBINDINGS_AVAILABLE_EVENT = "prefix-keybindings:available";
const PREFIX_KEYBINDINGS_REGISTER_EVENT = "prefix-keybindings:register";

// The bus round-trip is normally synchronous, so this only fires when the
// prefix-keybindings extension is missing entirely.
const DEFAULT_AVAILABILITY_TIMEOUT_MS = 2000;

export type EventBus = {
	emit(event: string, payload?: unknown): void;
	on(event: string, handler: (payload?: unknown) => void): () => void;
};

export type Scheduler = (fn: () => void, ms: number) => () => void;

export type Claim = {
	key: string;
	eventId: string;
	onFire: () => void;
};

export type StashBindingOptions = {
	events: EventBus;
	claims: Claim[];
	/** Invoked once if prefix-keybindings never answers. */
	onInert: () => void;
	schedule?: Scheduler;
	availabilityTimeoutMs?: number;
};

const defaultScheduler: Scheduler = (fn, ms) => {
	const handle = setTimeout(fn, ms);
	return () => clearTimeout(handle);
};

export function startStashBinding(opts: StashBindingOptions): () => void {
	const schedule = opts.schedule ?? defaultScheduler;
	const timeoutMs = opts.availabilityTimeoutMs ?? DEFAULT_AVAILABILITY_TIMEOUT_MS;

	// First-wins settlement: either the prefix extension answers (register every
	// claim) or the window expires (go inert). Once settled, further events are
	// no-ops, so a late `available` after going inert cannot belatedly activate.
	let outcome: "claimed" | "inert" | null = null;
	let cleaned = false;
	const cleanups: Array<() => void> = [];

	const cancelAvailabilityTimer = schedule(() => {
		if (outcome) return;
		outcome = "inert";
		opts.onInert();
	}, timeoutMs);

	const offAvailable = opts.events.on(PREFIX_KEYBINDINGS_AVAILABLE_EVENT, () => {
		if (outcome) return;
		outcome = "claimed";
		cancelAvailabilityTimer();
		for (const claim of opts.claims) {
			opts.events.emit(PREFIX_KEYBINDINGS_REGISTER_EVENT, {
				requester: "pi-stash",
				key: claim.key,
				eventId: claim.eventId,
			});
		}
	});

	for (const claim of opts.claims) {
		const off = opts.events.on(claim.eventId, () => {
			if (outcome === "claimed") claim.onFire();
		});
		cleanups.push(off);
	}

	cleanups.push(offAvailable, cancelAvailabilityTimer);

	opts.events.emit(PREFIX_KEYBINDINGS_QUERY_EVENT, { requester: "pi-stash" });

	return () => {
		if (cleaned) return;
		cleaned = true;
		while (cleanups.length) cleanups.shift()?.();
	};
}
