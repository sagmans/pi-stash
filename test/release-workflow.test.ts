import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

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

test("release verifies one immutable package across every supported matrix leg", () => {
	const packageJob = job("package", "verify");
	const verifyJob = job("verify", "publish");

	assert.match(packageJob, /npm pack --pack-destination artifact/);
	assert.match(packageJob, /uses: actions\/upload-artifact@[0-9a-f]{40}/);
	assert.match(packageJob, /name: npm-package/);
	assert.match(packageJob, /path: artifact\/\*\.tgz/);

	assert.match(verifyJob, /needs: package/);
	assert.match(verifyJob, /fail-fast: false/);
	assert.match(verifyJob, /os: \[ubuntu-latest, macos-latest\]/);
	assert.match(verifyJob, /node: \["22\.19\.0", "24"\]/);
	assert.match(verifyJob, /runs-on: \$\{\{ matrix\.os \}\}/);
	assert.match(verifyJob, /node-version: \$\{\{ matrix\.node \}\}/);
	assert.match(verifyJob, /uses: actions\/download-artifact@[0-9a-f]{40}/);
	assert.match(verifyJob, /name: npm-package/);
	assert.match(verifyJob, /npm run verify:ci/);
	assert.match(verifyJob, /npm install --ignore-scripts --prefix "\$install_root" "\$package"/);
	assert.doesNotMatch(verifyJob, /continue-on-error:/);
});

test("publication cannot bypass the complete matrix or rebuild its artifact", () => {
	const publishJob = job("publish");

	assert.match(publishJob, /needs: \[package, verify\]/);
	assert.match(publishJob, /uses: actions\/download-artifact@[0-9a-f]{40}/);
	assert.match(publishJob, /name: npm-package/);
	assert.match(publishJob, /npm publish "\$package" --provenance --access public/);
	assert.doesNotMatch(publishJob, /actions\/checkout/);
	assert.doesNotMatch(publishJob, /npm pack|npm run|continue-on-error:|if:\s*\$\{\{\s*always\(\)/);
});
