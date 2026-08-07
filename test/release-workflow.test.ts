import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const CI_WORKFLOW = readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8");
const RELEASE_WORKFLOW = path.resolve(".github/workflows/release.yml");
const WORKFLOW = readFileSync(RELEASE_WORKFLOW, "utf8");

function job(name: string, nextName?: string): string {
	const start = WORKFLOW.indexOf(`  ${name}:\n`);
	assert.notEqual(start, -1, `missing ${name} job`);
	const end =
		nextName === undefined ? WORKFLOW.length : WORKFLOW.indexOf(`  ${nextName}:\n`, start + 1);
	assert.notEqual(end, -1, `missing ${nextName} job`);
	return WORKFLOW.slice(start, end);
}

test("only the release workflow runs for version tags", () => {
	const ciHeader = CI_WORKFLOW.slice(0, CI_WORKFLOW.indexOf("jobs:\n"));
	const releaseHeader = WORKFLOW.slice(0, WORKFLOW.indexOf("jobs:\n"));

	assert.doesNotMatch(ciHeader, /tags:/);
	assert.match(releaseHeader, /push:\n\s+tags: \["v\*"\]/);
});

test("CI verifies source once on Ubuntu with Node 24", () => {
	assert.match(CI_WORKFLOW, /runs-on: ubuntu-latest/);
	assert.match(CI_WORKFLOW, /node-version: "24"/);
	assert.doesNotMatch(CI_WORKFLOW, /strategy:|matrix:|macos-latest|22\.19\.0/);
	assert.match(CI_WORKFLOW, /npm run verify:ci/);
});

test("release verifies one immutable package on Ubuntu with Node 24", () => {
	const packageJob = job("package", "verify");
	const verifyJob = job("verify", "publish");

	assert.match(packageJob, /npm pack --pack-destination artifact/);
	assert.match(packageJob, /uses: actions\/upload-artifact@[0-9a-f]{40}/);
	assert.match(packageJob, /name: npm-package/);
	assert.match(packageJob, /path: artifact\/\*\.tgz/);

	assert.match(verifyJob, /needs: package/);
	assert.match(verifyJob, /runs-on: ubuntu-latest/);
	assert.match(verifyJob, /node-version: "24"/);
	assert.doesNotMatch(verifyJob, /strategy:|matrix:|macos-latest|22\.19\.0/);
	assert.match(verifyJob, /uses: actions\/download-artifact@[0-9a-f]{40}/);
	assert.match(verifyJob, /name: npm-package/);
	assert.match(verifyJob, /npm run verify:ci/);
	assert.match(verifyJob, /npm install --ignore-scripts --prefix "\$install_root" "\$package"/);
	assert.doesNotMatch(verifyJob, /continue-on-error:/);
	assert.doesNotMatch(verifyJob, /NODE_NO_WARNINGS|--experimental-transform-types/);
});

test("publication cannot bypass artifact verification or rebuild its artifact", () => {
	const publishJob = job("publish");
	const workflowHeader = WORKFLOW.slice(0, WORKFLOW.indexOf("jobs:\n"));

	assert.match(workflowHeader, /push:\n\s+tags: \["v\*"\]/);
	assert.match(workflowHeader, /permissions:\n\s+contents: read/);
	assert.doesNotMatch(workflowHeader, /id-token: write/);
	assert.match(publishJob, /needs: \[package, verify\]/);
	assert.match(publishJob, /uses: actions\/download-artifact@[0-9a-f]{40}/);
	assert.match(publishJob, /name: npm-package/);
	assert.match(publishJob, /environment: npm-release/);
	assert.match(publishJob, /permissions:\n\s+contents: read\n\s+id-token: write/);
	assert.match(publishJob, /registry-url: "https:\/\/registry\.npmjs\.org"/);
	assert.match(publishJob, /npm publish "\$package" --provenance --access public/);
	assert.doesNotMatch(publishJob, /actions\/checkout|NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
	assert.doesNotMatch(publishJob, /npm pack|npm run|continue-on-error:|if:\s*\$\{\{\s*always\(\)/);
});

const ENTRY_HELPER = path.resolve("scripts/release/verify-package-entry.mjs");
const ENTRY_PACKAGE_MANIFEST = JSON.stringify({
	name: "@sagmans/pi-stash",
	version: "0.0.0",
	type: "module",
	main: "./index.ts",
	exports: { ".": "./index.ts" },
});

function withInstalledPackage(entrySource: string, run: (installRoot: string) => void): void {
	const installRoot = mkdtempSync(path.join(tmpdir(), "pi-stash-entry-test-"));
	try {
		const pkgDir = path.join(installRoot, "node_modules", "@sagmans", "pi-stash");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(path.join(pkgDir, "package.json"), ENTRY_PACKAGE_MANIFEST);
		writeFileSync(path.join(pkgDir, "index.ts"), entrySource);
		run(installRoot);
	} finally {
		rmSync(installRoot, { recursive: true, force: true });
	}
}

test("package entry verifier accepts a TypeScript-only default extension function", () => {
	withInstalledPackage("export default function piStash(): void {}\n", (installRoot) => {
		const result = spawnSync(process.execPath, [ENTRY_HELPER, installRoot], {
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
	});
});

test("package entry verifier rejects a non-function default export", () => {
	withInstalledPackage(
		'const entry: string = "pi-stash";\nexport default entry;\n',
		(installRoot) => {
			const result = spawnSync(process.execPath, [ENTRY_HELPER, installRoot], {
				encoding: "utf8",
			});
			assert.notEqual(result.status, 0);
		},
	);
});

test("package entry verifier rejects a TypeScript-only package that adds a named export", () => {
	withInstalledPackage(
		"export default function piStash(): void {}\nexport const extra = 1;\n",
		(installRoot) => {
			const result = spawnSync(process.execPath, [ENTRY_HELPER, installRoot], {
				encoding: "utf8",
			});
			assert.notEqual(result.status, 0);
		},
	);
});
