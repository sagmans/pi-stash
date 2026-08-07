// Session and migration work share one cancellation contract so replacement
// and shutdown can await every operation that may still touch storage or UI.

export class AbortableOperationQueue {
	private readonly controller = new AbortController();
	private tail: Promise<void> = Promise.resolve();

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get aborted(): boolean {
		return this.signal.aborted;
	}

	enqueue(operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.aborted) return Promise.resolve();
		const pending = this.tail.then(async () => {
			if (this.aborted) return;
			await operation(this.signal);
		});
		this.tail = pending.catch(() => undefined);
		return pending;
	}

	async close(): Promise<void> {
		this.controller.abort();
		await this.tail;
	}
}
