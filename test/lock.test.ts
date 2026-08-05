import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { CommittedMutationError, withStashMutationLock } from "../src/lock.ts";

let scratch: string;
let filePath: string;

beforeEach(() => {
	scratch = mkdtempSync(path.join(tmpdir(), "pi-stash-lock-"));
	filePath = path.join(scratch, "stash.json");
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function poisonOwner(): void {
	const lockPath = `${filePath}.lock`;
	const ownerPath = path.join(lockPath, "owner.json");
	const targetPath = path.join(scratch, "poison-owner.json");
	rmSync(ownerPath);
	writeFileSync(targetPath, "not an owner");
	symlinkSync(targetPath, ownerPath);
}

test("withStashMutationLock does not call a no-op committed when unlock fails", async () => {
	await assert.rejects(
		() =>
			withStashMutationLock(filePath, async () => {
				poisonOwner();
				return { didPersist: false, result: "unchanged" };
			}),
		(error: unknown) =>
			!(error instanceof CommittedMutationError) && String(error).includes("symbolic link"),
	);
});

test("withStashMutationLock reports lock release after persisted work", async () => {
	await assert.rejects(
		() =>
			withStashMutationLock(filePath, async () => {
				poisonOwner();
				return { didPersist: true, result: "saved" };
			}),
		(error: unknown) =>
			error instanceof CommittedMutationError &&
			error.result === "saved" &&
			error.failures.some(({ phase }) => phase === "lock-release"),
	);
});

test("withStashMutationLock preserves directory-sync and lock-release phases", async () => {
	await assert.rejects(
		() =>
			withStashMutationLock(filePath, async () => {
				poisonOwner();
				throw new CommittedMutationError("saved", [
					{ phase: "directory-sync", error: new Error("sync failed") },
				]);
			}),
		(error: unknown) =>
			error instanceof CommittedMutationError &&
			error.result === "saved" &&
			error.failures.map(({ phase }) => phase).join(",") === "directory-sync,lock-release",
	);
});
