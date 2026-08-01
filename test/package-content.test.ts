import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

type PackResult = { files: Array<{ path: string }> };

const PREFIX_PROTOCOL = "prefix-keybindings";

test("published package contains no retired prefix protocol", () => {
	const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		encoding: "utf8",
	});
	const [packed] = JSON.parse(output) as PackResult[];
	assert.ok(packed);
	const paths = packed.files.map(({ path }) => path);
	assert.equal(paths.includes("src/prefix.ts"), false);
	for (const file of paths.filter((file) => /\.(?:json|md|ts)$/u.test(file))) {
		assert.equal(readFileSync(file, "utf8").includes(PREFIX_PROTOCOL), false, file);
	}
});
