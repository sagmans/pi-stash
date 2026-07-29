// Fixed prefix-keybindings protocol for stash and list actions.
// Per-instance event IDs isolate duplicate loads; requester/key validation keeps
// dispatch bound to the registry winner while slash commands remain fallback.

const PREFIX_KEYBINDINGS_QUERY_EVENT = "prefix-keybindings:query";
const PREFIX_KEYBINDINGS_AVAILABLE_EVENT = "prefix-keybindings:available";
const PREFIX_KEYBINDINGS_REGISTER_EVENT = "prefix-keybindings:register";
const STASH_KEY = "s";
const LIST_KEY = "S";
const DEFAULT_AVAILABILITY_TIMEOUT_MS = 2000;

export type EventBus = {
	emit(event: string, payload?: unknown): void;
	on(event: string, handler: (payload?: unknown) => void): () => void;
};

export type Scheduler = (fn: () => void, ms: number) => () => void;

export type StashBindingOptions = {
	events: EventBus;
	/** Unique package-instance identity used to isolate duplicate loads. */
	requester: string;
	onStash(): void;
	onList(): void;
	/** Invoked once if prefix-keybindings never answers. */
	onInert(): void;
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
	const actions = [
		{ key: STASH_KEY, eventId: `${opts.requester}:stash`, fire: opts.onStash },
		{ key: LIST_KEY, eventId: `${opts.requester}:list`, fire: opts.onList },
	];
	let state: "waiting" | "claimed" | "inert" | "cleaned" = "waiting";
	const cleanups: Array<() => void> = [];

	const cancelAvailabilityTimer = schedule(() => {
		if (state !== "waiting") return;
		state = "inert";
		opts.onInert();
	}, opts.availabilityTimeoutMs ?? DEFAULT_AVAILABILITY_TIMEOUT_MS);

	cleanups.push(
		opts.events.on(PREFIX_KEYBINDINGS_AVAILABLE_EVENT, (raw) => {
			if (state !== "waiting") return;
			const prefixKey = availablePrefix(raw);
			if (!prefixKey) return;
			state = "claimed";
			cancelAvailabilityTimer();
			for (const action of actions) {
				opts.events.emit(PREFIX_KEYBINDINGS_REGISTER_EVENT, {
					requester: opts.requester,
					key: action.key,
					eventId: action.eventId,
				});
			}
			opts.onActive?.(prefixKey);
		}),
	);

	for (const action of actions) {
		cleanups.push(
			opts.events.on(action.eventId, (raw) => {
				if (state === "claimed" && isOwnedAction(raw, opts.requester, action.key)) action.fire();
			}),
		);
	}

	cleanups.push(cancelAvailabilityTimer);
	opts.events.emit(PREFIX_KEYBINDINGS_QUERY_EVENT, { requester: opts.requester });

	return () => {
		if (state === "cleaned") return;
		state = "cleaned";
		while (cleanups.length) cleanups.shift()?.();
	};
}
