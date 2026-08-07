import { strict as assert } from "node:assert";
import { test } from "node:test";

import { AbortableOperationQueue } from "../src/operation-queue.ts";

const FIRST_STARTED = "first-started";
const FIRST_FINISHED = "first-finished";
const SECOND_STARTED = "second-started";
const QUEUE_FAILURE_MESSAGE = "expected queue failure";

type Deferred = {
	promise: Promise<void>;
	resolve: () => void;
};

function deferred(): Deferred {
	let resolve = () => {};
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

test("AbortableOperationQueue serializes work and survives a rejected operation", async () => {
	const queue = new AbortableOperationQueue();
	const gate = deferred();
	const events: string[] = [];
	const first = queue.enqueue(async () => {
		events.push(FIRST_STARTED);
		await gate.promise;
		events.push(FIRST_FINISHED);
		throw new Error(QUEUE_FAILURE_MESSAGE);
	});
	const second = queue.enqueue(async () => {
		events.push(SECOND_STARTED);
	});

	await Promise.resolve();
	assert.deepEqual(events, [FIRST_STARTED]);
	gate.resolve();
	await assert.rejects(first, new RegExp(QUEUE_FAILURE_MESSAGE, "u"));
	await second;
	assert.deepEqual(events, [FIRST_STARTED, FIRST_FINISHED, SECOND_STARTED]);
});

test("AbortableOperationQueue close aborts tracked work and rejects new work", async () => {
	const queue = new AbortableOperationQueue();
	const started = deferred();
	let observedAbort = false;
	let ranAfterClose = false;
	const pending = queue.enqueue(async (signal) => {
		started.resolve();
		await new Promise<void>((resolve) => {
			signal.addEventListener(
				"abort",
				() => {
					observedAbort = true;
					resolve();
				},
				{ once: true },
			);
		});
	});

	await started.promise;
	await queue.close();
	await pending;
	await queue.enqueue(async () => {
		ranAfterClose = true;
	});

	assert.equal(observedAbort, true);
	assert.equal(ranAfterClose, false);
});
