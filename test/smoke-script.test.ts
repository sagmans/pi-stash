import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const SMOKE_SCRIPT = path.resolve("scripts/maintainer-smoke-herdr.sh");
const SCRIPT = readFileSync(SMOKE_SCRIPT, "utf8");

test("Herdr smoke runs two packaged-extension launches without seeded stash state", () => {
	assert.match(SCRIPT, /package_input="\$\{1:-\}"/);
	assert.match(SCRIPT, /package\/index\.ts/);
	assert.match(SCRIPT, /scripts\/smoke\/driver\.ts/);
	assert.match(SCRIPT, /create_pane stash/);
	assert.match(SCRIPT, /create_pane restore/);
	assert.match(SCRIPT, /PI_STASH_SMOKE_STASHED/);
	assert.match(SCRIPT, /PI_STASH_SMOKE_RESTORE_READY/);
	assert.doesNotMatch(SCRIPT, /STASH_SCHEMA_VERSION|FIXTURE_ID|experimental-transform-types/);
});

test("Herdr smoke proves image persistence, removal, warnings, and cleanup", () => {
	assert.match(SCRIPT, /assetCount !== 1/);
	assert.match(SCRIPT, /file\.entries\.length !== 0/);
	assert.match(SCRIPT, /Warning\|ExperimentalWarning\|extension_error\|PI_STASH_SMOKE_FAILED/);
	assert.match(SCRIPT, /herdr pane close/);
	assert.match(SCRIPT, /residual disposable data/);
});
