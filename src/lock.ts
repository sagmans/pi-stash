// Private cross-process lock protocol for one stash file.

import { mkdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
	assertPrivateDirectory,
	ensurePrivateDirectory,
	hasErrorCode,
	PRIVATE_DIR_MODE,
	pathExists,
	readPrivateTextFile,
	removePrivateDirectory,
	writePrivateFileExclusive,
} from "./private-fs.ts";
import { inspectProcessOwner, readProcessGeneration } from "./process-owner.ts";
import { createNewId } from "./types.ts";

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 30_000;
const LOCK_OWNER_FILE = "owner.json";
const LOCK_RECLAIM_SUFFIX = ".reclaim";
const LOCK_GENERATION_CHANGED_MESSAGE = "stash lock generation changed before release";
const MUTATION_AND_UNLOCK_ERROR_MESSAGE = "stash mutation and lock release both failed";

type LockOwner = {
	pid: number;
	host: string;
	token: string;
	generation: string;
	createdAt: string;
};

type LockState =
	| { kind: "missing" }
	| { kind: "dead"; owner: LockOwner }
	| { kind: "live"; owner: LockOwner }
	| { kind: "uncertain"; owner: LockOwner }
	| { kind: "malformed" };

export type CommittedMutationPhase = "directory-sync" | "lock-release";

export type CommittedMutationFailure = {
	phase: CommittedMutationPhase;
	error: unknown;
};

export class CommittedMutationError<Result = unknown> extends Error {
	readonly committed = true;
	readonly result: Result;
	readonly failures: readonly CommittedMutationFailure[];

	constructor(result: Result, failures: readonly CommittedMutationFailure[]) {
		const phases = failures.map(({ phase }) => phase).join(" and ");
		const cause =
			failures.length === 1
				? failures[0]?.error
				: new AggregateError(
						failures.map(({ error }) => error),
						MUTATION_AND_UNLOCK_ERROR_MESSAGE,
					);
		super(`stash mutation committed but ${phases} failed`, { cause });
		this.name = "CommittedMutationError";
		this.result = result;
		this.failures = [...failures];
	}

	withFailure(failure: CommittedMutationFailure): CommittedMutationError<Result> {
		return new CommittedMutationError(this.result, [...this.failures, failure]);
	}

	hasFailure(phase: CommittedMutationPhase): boolean {
		return this.failures.some((failure) => failure.phase === phase);
	}
}

export type StashMutationResult<Result> = {
	didPersist: boolean;
	result: Result;
};

/** Coordinate migration and reads without classifying successful work as a mutation. */
export function withStashFileLock<Result>(
	filePath: string,
	operation: () => Promise<Result>,
): Promise<Result> {
	return withStashLock(filePath, operation);
}

/** Classify unlock failure as committed only when the callback persisted state. */
export async function withStashMutationLock<Result>(
	filePath: string,
	operation: () => Promise<StashMutationResult<Result>>,
): Promise<Result> {
	const outcome = await withStashLock(filePath, operation, true);
	return outcome.result;
}

async function withStashLock<Result>(
	filePath: string,
	operation: () => Promise<Result>,
	mutation = false,
): Promise<Result> {
	await ensurePrivateDirectory(path.dirname(filePath));
	const lockPath = `${filePath}.lock`;
	const owner = await acquireStashLock(lockPath);
	let result: Result;
	try {
		result = await operation();
	} catch (operationError) {
		try {
			await releaseStashLock(lockPath, owner);
		} catch (cleanupError) {
			if (operationError instanceof CommittedMutationError) {
				throw operationError.withFailure({ phase: "lock-release", error: cleanupError });
			}
			throw new AggregateError([operationError, cleanupError], MUTATION_AND_UNLOCK_ERROR_MESSAGE);
		}
		throw operationError;
	}
	try {
		await releaseStashLock(lockPath, owner);
	} catch (cleanupError) {
		if (mutation && isPersistedMutation(result)) {
			throw new CommittedMutationError(result.result, [
				{ phase: "lock-release", error: cleanupError },
			]);
		}
		throw cleanupError;
	}
	return result;
}

function isPersistedMutation(value: unknown): value is StashMutationResult<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"didPersist" in value &&
		value.didPersist === true &&
		"result" in value
	);
}

async function acquireStashLock(lockPath: string): Promise<LockOwner> {
	const startedAt = Date.now();
	for (;;) {
		try {
			await mkdir(lockPath, { mode: PRIVATE_DIR_MODE });
			try {
				const reclaimPath = `${lockPath}${LOCK_RECLAIM_SUFFIX}`;
				if (await pathExists(reclaimPath)) {
					if (await isRecoverableLock(reclaimPath)) {
						// A dead guard cannot retain authority after this contender owns the lock.
						await removePrivateDirectory(reclaimPath, "stash lock reclamation guard");
					} else {
						await rm(lockPath, { force: true, recursive: true });
						if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
							throw new Error(lockTimeoutMessage(reclaimPath, await inspectLockState(reclaimPath)));
						}
						await delay(LOCK_RETRY_MS);
						continue;
					}
				}
				await ensurePrivateDirectory(lockPath, "stash lock");
				return await writeLockOwner(lockPath);
			} catch (error) {
				await rm(lockPath, { force: true, recursive: true });
				throw error;
			}
		} catch (error) {
			if (!hasErrorCode(error, "EEXIST")) throw error;
			try {
				await assertPrivateDirectory(lockPath, "stash lock");
			} catch (validationError) {
				if (hasErrorCode(validationError, "ENOENT")) continue;
				throw validationError;
			}
			if (await reclaimAbandonedLock(lockPath)) continue;
			if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
				throw new Error(lockTimeoutMessage(lockPath, await inspectLockState(lockPath)));
			}
			await delay(LOCK_RETRY_MS);
		}
	}
}

async function writeLockOwner(lockPath: string): Promise<LockOwner> {
	const owner: LockOwner = {
		pid: process.pid,
		host: hostname(),
		token: createNewId(),
		generation: await readProcessGeneration(process.pid),
		createdAt: new Date().toISOString(),
	};
	await writePrivateFileExclusive(
		path.join(lockPath, LOCK_OWNER_FILE),
		`${JSON.stringify(owner)}\n`,
	);
	return owner;
}

async function readLockOwner(lockPath: string): Promise<LockOwner | undefined> {
	let text: string;
	try {
		await assertPrivateDirectory(lockPath, "stash lock");
		text = (await readPrivateTextFile(path.join(lockPath, LOCK_OWNER_FILE), "lock owner file"))
			.text;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
	try {
		const value: unknown = JSON.parse(text);
		return isLockOwner(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function isLockOwner(value: unknown): value is LockOwner {
	return (
		typeof value === "object" &&
		value !== null &&
		"pid" in value &&
		Number.isSafeInteger(value.pid) &&
		"host" in value &&
		typeof value.host === "string" &&
		"token" in value &&
		typeof value.token === "string" &&
		"generation" in value &&
		typeof value.generation === "string" &&
		value.generation.length > 0 &&
		"createdAt" in value &&
		typeof value.createdAt === "string"
	);
}

async function releaseStashLock(lockPath: string, expected: LockOwner): Promise<void> {
	const owner = await readLockOwner(lockPath);
	if (!sameLockGeneration(owner, expected)) throw new Error(LOCK_GENERATION_CHANGED_MESSAGE);
	await rm(lockPath, { force: true, recursive: true });
}

async function reclaimAbandonedLock(lockPath: string): Promise<boolean> {
	const reclaimPath = `${lockPath}${LOCK_RECLAIM_SUFFIX}`;
	const reclaimOwner = await acquireReclaimGuard(reclaimPath);
	if (!reclaimOwner) return false;
	try {
		// Rechecking under the guard prevents deleting a newly published owner.
		if (!(await isRecoverableLock(lockPath))) return false;
		await removePrivateDirectory(lockPath, "stash lock");
		return true;
	} finally {
		await releaseStashLock(reclaimPath, reclaimOwner);
	}
}

async function acquireReclaimGuard(reclaimPath: string): Promise<LockOwner | undefined> {
	try {
		await mkdir(reclaimPath, { mode: PRIVATE_DIR_MODE });
		try {
			await ensurePrivateDirectory(reclaimPath, "stash lock reclamation guard");
			return await writeLockOwner(reclaimPath);
		} catch (error) {
			await rm(reclaimPath, { force: true, recursive: true });
			throw error;
		}
	} catch (error) {
		if (!hasErrorCode(error, "EEXIST")) throw error;
		await assertPrivateDirectory(reclaimPath, "stash lock reclamation guard");
		if (await isRecoverableLock(reclaimPath)) {
			await removePrivateDirectory(reclaimPath, "stash lock reclamation guard");
		}
		return undefined;
	}
}

async function isRecoverableLock(lockPath: string): Promise<boolean> {
	let stats: Awaited<ReturnType<typeof assertPrivateDirectory>>;
	try {
		stats = await assertPrivateDirectory(lockPath, "stash lock");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	}
	const state = await inspectLockState(lockPath);
	if (state.kind === "dead") return true;
	return state.kind === "malformed" && Date.now() - stats.mtimeMs > LOCK_STALE_MS;
}

async function inspectLockState(lockPath: string): Promise<LockState> {
	const owner = await readLockOwner(lockPath);
	if (!owner) return (await pathExists(lockPath)) ? { kind: "malformed" } : { kind: "missing" };
	const processState = await inspectProcessOwner(owner);
	if (processState === "dead") return { kind: "dead", owner };
	if (processState === "live") return { kind: "live", owner };
	if (owner.host !== hostname()) return { kind: "uncertain", owner };
	const stats = await assertPrivateDirectory(lockPath, "stash lock");
	return Date.now() - stats.mtimeMs <= LOCK_STALE_MS
		? { kind: "live", owner }
		: { kind: "uncertain", owner };
}

function sameLockGeneration(actual: LockOwner | undefined, expected: LockOwner): boolean {
	return actual?.token === expected.token && actual.generation === expected.generation;
}

function lockTimeoutMessage(lockPath: string, state: LockState): string {
	switch (state.kind) {
		case "live":
			return `timed out waiting for pi-stash lock ${lockPath}: live lock owner pid ${state.owner.pid}`;
		case "uncertain":
			return `timed out waiting for pi-stash lock ${lockPath}: uncertain lock owner pid ${state.owner.pid}`;
		case "malformed":
			return `timed out waiting for pi-stash lock ${lockPath}: malformed lock owner metadata`;
		case "dead":
			return `timed out recovering dead pi-stash lock ${lockPath}`;
		case "missing":
			return `timed out waiting for replaced pi-stash lock ${lockPath}`;
		default: {
			const exhaustive: never = state;
			return exhaustive;
		}
	}
}
