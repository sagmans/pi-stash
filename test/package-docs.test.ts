import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const README = readFileSync("README.md", "utf8");
const PACKAGE = JSON.parse(readFileSync("package.json", "utf8")) as { files?: string[] };
const STORAGE_GUIDE = "docs/storage-recovery.md";
const REQUIRED_PACKAGE_DOCS = [
	"docs",
	"CHANGELOG.md",
	"CONTEXT.md",
	"CONTRIBUTING.md",
	"RELEASE.md",
	"SECURITY.md",
];

test("published documentation includes every package-relative README target", () => {
	for (const included of REQUIRED_PACKAGE_DOCS)
		assert.ok(PACKAGE.files?.includes(included), included);
	const links = [...README.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)].map((match) => match[1]);
	for (const target of links) {
		if (!target || /^[a-z]+:/iu.test(target) || target.startsWith("#")) continue;
		const localPath = target.split("#", 1)[0];
		assert.ok(localPath && existsSync(localPath), `missing README target: ${target}`);
		assert.ok(statSync(localPath).isFile() || statSync(localPath).isDirectory());
	}
});

test("every published documentation link resolves from its package location", () => {
	const rootDocuments = REQUIRED_PACKAGE_DOCS.filter((entry) => entry.endsWith(".md"));
	const docs = readdirSync("docs", { recursive: true })
		.filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".md"))
		.map((entry) => path.join("docs", entry));
	for (const document of ["README.md", ...rootDocuments, ...docs]) {
		const contents = readFileSync(document, "utf8");
		for (const match of contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
			const target = match[1];
			if (!target || /^[a-z]+:/iu.test(target) || target.startsWith("#")) continue;
			const localTarget = target.split("#", 1)[0];
			assert.ok(
				localTarget && existsSync(path.resolve(path.dirname(document), localTarget)),
				`${document} has missing target: ${target}`,
			);
		}
	}
});

test("installation and storage guidance exposes privilege and recovery boundaries", () => {
	assert.match(README, /full local privileges/iu);
	assert.match(README, /does not sandbox/iu);
	assert.match(README, new RegExp(STORAGE_GUIDE.replace(".", "\\."), "u"));

	const storageGuide = readFileSync(path.resolve(STORAGE_GUIDE), "utf8");
	assert.match(storageGuide, /configured Pi agent directory/iu);
	assert.match(storageGuide, /legacy/iu);
	assert.match(storageGuide, /0700/u);
	assert.match(storageGuide, /0600/u);
	assert.match(storageGuide, /unsupported schema/iu);
	assert.match(storageGuide, /quarantin/iu);
	assert.match(storageGuide, /cleanup failure/iu);
	assert.match(storageGuide, /non-destructive/iu);
});
