import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

type PackResult = { files: Array<{ path: string }> };

// npm 12 keys the dry-run report by package name, while npm 11 and earlier emit one array element.
type PackReport = PackResult[] | Record<string, PackResult>;

const PREFIX_PROTOCOL = "prefix-keybindings";

function packedReports(report: PackReport): PackResult[] {
	return Array.isArray(report) ? report : Object.values(report);
}

test("published package contains no retired prefix protocol", () => {
	const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		encoding: "utf8",
	});
	const [packed] = packedReports(JSON.parse(output) as PackReport);
	assert.ok(packed);
	const paths = packed.files.map(({ path }) => path);
	assert.equal(paths.includes("src/prefix.ts"), false);
	for (const file of paths.filter((file) => /\.(?:json|md|ts)$/u.test(file))) {
		assert.equal(readFileSync(file, "utf8").includes(PREFIX_PROTOCOL), false, file);
	}
});
