import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const PACKAGE_PATH = path.resolve("package.json");
const PACKAGE_LOCK_PATH = path.resolve("package-lock.json");
const TSCONFIG_PATH = path.resolve("tsconfig.json");
const CHANGELOG_PATH = path.resolve("CHANGELOG.md");
const UNRELEASED_HEADING = "## [Unreleased]";

type PackageManifest = {
	version: string;
	scripts: { audit: string; test: string };
};

type PackageLock = {
	version: string;
	packages: { "": { version: string } };
};

type TypeScriptConfig = {
	compilerOptions: { erasableSyntaxOnly?: boolean };
};

const manifest = JSON.parse(readFileSync(PACKAGE_PATH, "utf8")) as PackageManifest;
const packageLock = JSON.parse(readFileSync(PACKAGE_LOCK_PATH, "utf8")) as PackageLock;
const tsconfig = JSON.parse(readFileSync(TSCONFIG_PATH, "utf8")) as TypeScriptConfig;
const changelog = readFileSync(CHANGELOG_PATH, "utf8");

test("candidate gates warnings and uses native TypeScript stripping", () => {
	assert.equal(manifest.scripts.audit, "npm audit --audit-level=moderate");
	assert.equal(manifest.scripts.test, "node --test test/*.test.ts");
	assert.equal(tsconfig.compilerOptions.erasableSyntaxOnly, true);
});

test("candidate version is consistent and fully rolled into the changelog", () => {
	assert.equal(packageLock.version, manifest.version);
	assert.equal(packageLock.packages[""].version, manifest.version);

	const unreleasedStart = changelog.indexOf(UNRELEASED_HEADING);
	assert.notEqual(unreleasedStart, -1);
	const nextRelease = changelog.indexOf("\n## [", unreleasedStart + UNRELEASED_HEADING.length);
	assert.notEqual(nextRelease, -1);
	assert.equal(changelog.slice(unreleasedStart, nextRelease).trim(), UNRELEASED_HEADING);

	const escapedVersion = manifest.version.replaceAll(".", "\\.");
	const releaseHeadings = changelog.match(
		new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "gm"),
	);
	assert.equal(releaseHeadings?.length, 1);
});
