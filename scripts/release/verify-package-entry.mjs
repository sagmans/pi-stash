#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { cpSync, existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
	throw new Error(message);
}

async function main() {
	const args = process.argv.slice(2);
	if (args.length !== 1 || args[0].length === 0) {
		fail("usage: verify-package-entry.mjs <install-root>");
	}
	const [installRoot] = args;

	const resolvedRoot = path.resolve(installRoot);
	if (!statSync(resolvedRoot, { throwIfNoEntry: false })?.isDirectory()) {
		fail(`install root is not a directory: ${resolvedRoot}`);
	}

	const packageRoot = path.join(resolvedRoot, "node_modules", "@sagmans", "pi-stash");
	if (!existsSync(packageRoot)) {
		fail(`installed package not found: ${packageRoot}`);
	}

	// Node disables TypeScript type stripping inside node_modules, so import the
	// package from a sibling copy kept under the install root. Staying under the
	// install root keeps peer-dependency resolution walking up to
	// <install-root>/node_modules.
	const copyRoot = path.join(resolvedRoot, `.verify-pi-stash-${randomBytes(6).toString("hex")}`);
	try {
		cpSync(packageRoot, copyRoot, {
			recursive: true,
			filter: (source) => {
				const relative = path.relative(packageRoot, source);
				return relative === "" || !relative.split(path.sep).includes("node_modules");
			},
		});

		const namespace = await import(pathToFileURL(path.join(copyRoot, "index.ts")).href);
		const exports = Object.keys(namespace);
		if (exports.length !== 1 || exports[0] !== "default") {
			fail(`package must export only "default", got [${exports.join(", ")}]`);
		}
		if (typeof namespace.default !== "function") {
			fail(`package default export must be a function, got ${typeof namespace.default}`);
		}
	} finally {
		rmSync(copyRoot, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
