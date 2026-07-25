// No-follow filesystem primitives for sensitive draft storage.
//
// Path-based chmod/read helpers can follow a link swapped into place after a
// check. Opening the validated inode and operating through its handle keeps
// permission repair and reads bound to the object that was inspected.

import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, rm, unlink } from "node:fs/promises";
import path from "node:path";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const MAX_QUARANTINE_ATTEMPTS = 1000;
const NO_FOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = constants.O_DIRECTORY ?? 0;

type FileIdentity = Pick<Stats, "dev" | "ino">;

export type PrivateTextFile = {
	text: string;
	identity: FileIdentity;
};

export async function ensurePrivateDirectory(
	directory: string,
	label = "storage directory",
): Promise<void> {
	await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
	const handle = await openValidatedDirectory(directory, label);
	try {
		await handle.chmod(PRIVATE_DIR_MODE);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function assertPrivateDirectory(directory: string, label: string): Promise<Stats> {
	const handle = await openValidatedDirectory(directory, label);
	try {
		return await handle.stat();
	} finally {
		await handle.close();
	}
}

export async function syncPrivateDirectory(
	directory: string,
	label = "storage directory",
): Promise<void> {
	const handle = await openValidatedDirectory(directory, label);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function readPrivateTextFile(
	filePath: string,
	label = "stash file",
): Promise<PrivateTextFile> {
	const before = await lstat(filePath);
	assertRegularFile(before, label);
	assertCurrentUserOwns(before, label);
	const handle = await open(filePath, constants.O_RDONLY | NO_FOLLOW_FLAG);
	try {
		const opened = await handle.stat();
		assertRegularFile(opened, label);
		assertCurrentUserOwns(opened, label);
		assertSameIdentity(before, opened, label);
		await handle.chmod(PRIVATE_FILE_MODE);
		return {
			text: await handle.readFile("utf8"),
			identity: identityOf(opened),
		};
	} finally {
		await handle.close();
	}
}

export async function writePrivateTextFileExclusive(filePath: string, data: string): Promise<void> {
	const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW_FLAG;
	const handle = await open(filePath, flags, PRIVATE_FILE_MODE);
	let succeeded = false;
	try {
		await handle.writeFile(data, "utf8");
		await handle.chmod(PRIVATE_FILE_MODE);
		await handle.sync();
		succeeded = true;
	} finally {
		await handle.close();
		if (!succeeded) await rm(filePath, { force: true });
	}
}

export async function quarantinePrivateFile(
	filePath: string,
	identity: FileIdentity,
	label: string,
): Promise<string> {
	for (let attempt = 0; attempt < MAX_QUARANTINE_ATTEMPTS; attempt += 1) {
		const candidate = `${filePath}.${label}${attempt === 0 ? "" : `-${attempt}`}`;
		try {
			await link(filePath, candidate);
		} catch (error) {
			if (hasErrorCode(error, "EEXIST")) continue;
			throw error;
		}
		let moved = false;
		try {
			const candidateStats = await lstat(candidate);
			const sourceStats = await lstat(filePath);
			assertSameIdentity(candidateStats, identity, "quarantine source");
			assertSameIdentity(sourceStats, identity, "quarantine source");
			await unlink(filePath);
			moved = true;
			await syncPrivateDirectory(path.dirname(filePath));
			return candidate;
		} finally {
			if (!moved) await unlink(candidate).catch(() => undefined);
		}
	}
	throw new Error(`unable to reserve quarantine path for ${filePath}`);
}

export async function removePrivateDirectory(
	directory: string,
	label = "asset directory",
): Promise<void> {
	let stats: Stats;
	try {
		stats = await lstat(directory);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return;
		throw error;
	}
	assertDirectory(stats, label);
	assertCurrentUserOwns(stats, label);
	await rm(directory, { recursive: true });
	await syncPrivateDirectory(path.dirname(directory));
}

async function openValidatedDirectory(directory: string, label: string) {
	const before = await lstat(directory);
	assertDirectory(before, label);
	assertCurrentUserOwns(before, label);
	const handle = await open(directory, constants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW_FLAG);
	try {
		const opened = await handle.stat();
		assertDirectory(opened, label);
		assertCurrentUserOwns(opened, label);
		assertSameIdentity(before, opened, label);
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

function assertDirectory(stats: Stats, label: string): void {
	if (stats.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
	if (!stats.isDirectory()) throw new Error(`${label} must be a directory`);
}

function assertRegularFile(stats: Stats, label: string): void {
	if (stats.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
	if (!stats.isFile()) throw new Error(`${label} must be a regular file`);
}

function assertCurrentUserOwns(stats: Stats, label: string): void {
	const currentUid = process.getuid?.();
	if (currentUid !== undefined && stats.uid !== currentUid) {
		throw new Error(`${label} must be owned by the current user`);
	}
}

function assertSameIdentity(actual: FileIdentity, expected: FileIdentity, label: string): void {
	if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
		throw new Error(`${label} changed during validation`);
	}
}

function identityOf(stats: Stats): FileIdentity {
	return { dev: stats.dev, ino: stats.ino };
}

function hasErrorCode(value: unknown, code: string): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		(value as { code: unknown }).code === code
	);
}
