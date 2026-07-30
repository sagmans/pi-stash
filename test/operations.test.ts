import { strict as assert } from "node:assert";
import test from "node:test";

import { safeNotify } from "../src/operations.ts";

test("safeNotify strips terminal controls at the operation boundary", () => {
	const notifications: string[] = [];
	const ui = {
		notify: (message: string) => notifications.push(message),
	} as never;

	safeNotify(ui, "failure\u001b[2J\u202edetail", "error");

	assert.deepEqual(notifications, ["failuredetail"]);
});
