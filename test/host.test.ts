import { strict as assert } from "node:assert";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { formatKeyText, resolveAgentDir, StashBorder } from "../src/host.ts";

test("resolveAgentDir follows Pi's configured and default agent-directory contract", () => {
	assert.equal(
		resolveAgentDir({ PI_CODING_AGENT_DIR: "/profiles/work" }, "/Users/me"),
		"/profiles/work",
	);
	assert.equal(
		resolveAgentDir({ PI_CODING_AGENT_DIR: "~/profiles/work" }, "/Users/me"),
		path.join("/Users/me", "profiles/work"),
	);
	assert.equal(
		resolveAgentDir({ PI_CODING_AGENT_DIR: pathToFileURL("/profiles/work").href }, "/Users/me"),
		"/profiles/work",
	);
	assert.equal(resolveAgentDir({}, "/Users/me"), path.join("/Users/me", ".pi", "agent"));
});

test("formatKeyText preserves Pi's platform-specific key-label convention", () => {
	assert.equal(formatKeyText("alt+x/ctrl+y", "darwin"), "option+x/ctrl+y");
	assert.equal(formatKeyText("alt+x/ctrl+y", "linux"), "alt+x/ctrl+y");
});

test("StashBorder fills at least one terminal column", () => {
	const border = new StashBorder((text) => `[${text}]`);

	assert.deepEqual(border.render(0), ["[─]"]);
	assert.deepEqual(border.render(3), ["[───]"]);
});
