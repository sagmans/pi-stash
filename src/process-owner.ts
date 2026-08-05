// Shared process identity probes for lock and crash-intent ownership.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { promisify } from "node:util";

import { hasErrorCode } from "./private-fs.ts";
import { createNewId } from "./types.ts";

const PROC_STAT_START_TIME_INDEX = 19;
const PROCESS_GENERATION_FALLBACK = `opaque:${createNewId()}`;
const execFileAsync = promisify(execFile);
let selfProcessGeneration: Promise<string> | undefined;

export type ProcessOwner = {
	pid: number;
	host: string;
	generation?: string;
};

export type ProcessOwnerState = "live" | "dead" | "uncertain";

export async function inspectProcessOwner(owner: ProcessOwner): Promise<ProcessOwnerState> {
	if (owner.host !== hostname()) return "uncertain";
	const liveness = processLiveness(owner.pid);
	if (liveness !== "live") return liveness;
	const generation = await readProcessGeneration(owner.pid).catch(() => undefined);
	if (!generation || !owner.generation) return "uncertain";
	return generation === owner.generation ? "live" : "dead";
}

export async function readProcessGeneration(pid: number): Promise<string> {
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid process id");
	if (pid === process.pid) {
		selfProcessGeneration ??= readExternalProcessGeneration(pid).catch(
			() => PROCESS_GENERATION_FALLBACK,
		);
		return selfProcessGeneration;
	}
	return readExternalProcessGeneration(pid);
}

async function readExternalProcessGeneration(pid: number): Promise<string> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const commandEnd = stat.lastIndexOf(")");
		const fields =
			commandEnd >= 0
				? stat
						.slice(commandEnd + 2)
						.trim()
						.split(/\s+/u)
				: [];
		const startTime = fields[PROC_STAT_START_TIME_INDEX];
		if (startTime) return `proc:${startTime}`;
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) throw error;
	}
	const { stdout } = await execFileAsync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
		encoding: "utf8",
	});
	const startTime = stdout.trim();
	if (!startTime) throw new Error("process generation unavailable");
	return `ps:${startTime}`;
}

function processLiveness(pid: number): ProcessOwnerState {
	try {
		process.kill(pid, 0);
		return "live";
	} catch (error) {
		return hasErrorCode(error, "ESRCH") ? "dead" : "uncertain";
	}
}
