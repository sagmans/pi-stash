import { strict as assert } from "node:assert";
import { hostname } from "node:os";
import test from "node:test";

import { inspectProcessOwner, readProcessGeneration } from "../src/process-owner.ts";

const DEAD_PROCESS_ID = 2_147_483_647;

test("inspectProcessOwner distinguishes live, reused, dead, and foreign owners", async () => {
	const generation = await readProcessGeneration(process.pid);

	assert.equal(
		await inspectProcessOwner({ pid: process.pid, host: hostname(), generation }),
		"live",
	);
	assert.equal(
		await inspectProcessOwner({
			pid: process.pid,
			host: hostname(),
			generation: `${generation}-previous`,
		}),
		"dead",
	);
	assert.equal(
		await inspectProcessOwner({
			pid: DEAD_PROCESS_ID,
			host: hostname(),
			generation: "dead-generation",
		}),
		"dead",
	);
	assert.equal(
		await inspectProcessOwner({ pid: process.pid, host: "foreign-host", generation }),
		"uncertain",
	);
});

test("readProcessGeneration rejects invalid process ids", async () => {
	await assert.rejects(() => readProcessGeneration(0), /invalid process id/u);
});
