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
//                  -> on the key's owned action event, invoke its callback
//   no `available` -> after the window, invoke `onInert` once and stay dormant
//   session_shutdown / cleanup -> detach every listener and cancel the timer
//
// A claim is rejected silently by prefix-keybindings when the key is already
// taken. Per-instance requester and event IDs keep the winning registration
// isolated, while slash commands remain the reliable fallback.

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
	/** Unique package-instance identity used to isolate duplicate loads. */
	requester: string;
	claims: Claim[];
	/** Invoked once if prefix-keybindings never answers. */
	onInert: () => void;
	/** Reports the provider's effective prefix for truthful UI hints. */
	onActive?: (prefixKey: string) => void;
	schedule?: Scheduler;
	availabilityTimeoutMs?: number;
};

const defaultScheduler: Scheduler = (fn, ms) => {
	const handle = setTimeout(fn, ms);
	return () => clearTimeout(handle);
};

function availablePrefix(raw: unknown): string | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const { available, prefixKey } = raw as Record<string, unknown>;
	if (available !== true || typeof prefixKey !== "string") return undefined;
	const normalized = prefixKey.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function isOwnedAction(raw: unknown, requester: string, key: string): boolean {
	if (typeof raw !== "object" || raw === null) return false;
	const action = raw as Record<string, unknown>;
	return action.requester === requester && action.key === key;
}

export function startStashBinding(opts: StashBindingOptions): () => void {
	const schedule = opts.schedule ?? defaultScheduler;
	const timeoutMs = opts.availabilityTimeoutMs ?? DEFAULT_AVAILABILITY_TIMEOUT_MS;

	// First-wins settlement keeps competing availability announcements from
	// changing a session's effective binding after claims were registered.
	let outcome: "claimed" | "inert" | null = null;
	let cleaned = false;
	const cleanups: Array<() => void> = [];

	const cancelAvailabilityTimer = schedule(() => {
		if (cleaned || outcome) return;
		outcome = "inert";
		opts.onInert();
	}, timeoutMs);

	const offAvailable = opts.events.on(PREFIX_KEYBINDINGS_AVAILABLE_EVENT, (raw) => {
		if (cleaned || outcome) return;
		const prefixKey = availablePrefix(raw);
		if (!prefixKey) return;
		outcome = "claimed";
		cancelAvailabilityTimer();
		for (const claim of opts.claims) {
			opts.events.emit(PREFIX_KEYBINDINGS_REGISTER_EVENT, {
				requester: opts.requester,
				key: claim.key,
				eventId: claim.eventId,
			});
		}
		opts.onActive?.(prefixKey);
	});

	for (const claim of opts.claims) {
		const off = opts.events.on(claim.eventId, (raw) => {
			if (!cleaned && outcome === "claimed" && isOwnedAction(raw, opts.requester, claim.key)) {
				claim.onFire();
			}
		});
		cleanups.push(off);
	}

	cleanups.push(offAvailable, cancelAvailabilityTimer);
	opts.events.emit(PREFIX_KEYBINDINGS_QUERY_EVENT, { requester: opts.requester });

	return () => {
		if (cleaned) return;
		cleaned = true;
		while (cleanups.length) cleanups.shift()?.();
	};
}
