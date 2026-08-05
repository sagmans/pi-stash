import { strict as assert } from "node:assert";
import test from "node:test";

import install from "@sagmans/pi-stash";

test("published root exposes only the Pi extension installer", async () => {
	const api = await import("@sagmans/pi-stash");

	assert.equal(typeof install, "function");
	assert.deepEqual(Object.keys(api), ["default"]);
});

test("package exports reject internal deep entry points", async () => {
	const internalSpecifier = "@sagmans/pi-stash/src/store.ts";

	await assert.rejects(() => import(internalSpecifier), /package subpath|exports/iu);
});
