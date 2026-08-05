#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const SCHEMA_VERSION = 1;
const MAX_WAIVER_DURATION_MS = 72 * 60 * 60 * 1000;
const MIN_REASON_LENGTH = 20;
const MAX_REASON_LENGTH = 1000;
const MAX_EVIDENCE_ITEMS = 10;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const OWNER_PATTERN = /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/u;
const ALLOWED_SCOPES = new Set([
	"gate-1",
	"gate-2",
	"gate-3",
	"gate-4",
	"gate-5",
	"gate-6",
	"gate-7",
]);
const REQUIRED_KEYS = [
	"candidateSha",
	"createdAt",
	"evidence",
	"expiresAt",
	"owner",
	"reason",
	"schemaVersion",
	"scope",
];

function invalid(reason) {
	throw new Error(reason);
}

function parseTimestamp(value, field) {
	if (typeof value !== "string") invalid(`${field} must be a timestamp`);
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
		invalid(`${field} must be a canonical UTC timestamp`);
	}
	return timestamp;
}

function validateEvidence(value) {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EVIDENCE_ITEMS) {
		invalid("evidence must be a bounded non-empty array");
	}
	for (const item of value) {
		if (typeof item !== "string") invalid("evidence entries must be HTTPS URLs");
		let url;
		try {
			url = new URL(item);
		} catch {
			invalid("evidence entries must be HTTPS URLs");
		}
		if (url.protocol !== "https:" || url.username || url.password) {
			invalid("evidence entries must be HTTPS URLs without credentials");
		}
	}
}

function validateWaiver(record, expectedSha, expectedOwner, expectedScope, now = Date.now()) {
	if (typeof record !== "object" || record === null || Array.isArray(record)) {
		invalid("record must be an object");
	}
	const keys = Object.keys(record).sort();
	if (
		keys.length !== REQUIRED_KEYS.length ||
		keys.some((key, index) => key !== REQUIRED_KEYS[index])
	) {
		invalid("record fields do not match schema");
	}
	if (record.schemaVersion !== SCHEMA_VERSION) invalid("unknown schema version");
	if (!SHA_PATTERN.test(record.candidateSha) || record.candidateSha !== expectedSha) {
		invalid("candidate SHA does not match");
	}
	if (!OWNER_PATTERN.test(record.owner) || record.owner !== expectedOwner) {
		invalid("owner does not match");
	}
	if (!ALLOWED_SCOPES.has(record.scope) || record.scope !== expectedScope) {
		invalid("scope is unknown, broad, or does not match");
	}
	if (
		typeof record.reason !== "string" ||
		record.reason !== record.reason.trim() ||
		record.reason.length < MIN_REASON_LENGTH ||
		record.reason.length > MAX_REASON_LENGTH
	) {
		invalid("reason must be specific and bounded");
	}
	validateEvidence(record.evidence);
	const createdAt = parseTimestamp(record.createdAt, "createdAt");
	const expiresAt = parseTimestamp(record.expiresAt, "expiresAt");
	if (createdAt > now) invalid("waiver creation is in the future");
	if (expiresAt <= now) invalid("waiver is expired");
	if (expiresAt <= createdAt || expiresAt - createdAt > MAX_WAIVER_DURATION_MS) {
		invalid("waiver lifetime is invalid or over-broad");
	}
}

async function main() {
	const [file, expectedSha, expectedOwner, expectedScope, ...extra] = process.argv.slice(2);
	if (!file || !expectedSha || !expectedOwner || !expectedScope || extra.length > 0) {
		invalid("usage: validate-waiver.mjs <file> <candidate-sha> <owner> <gate-N>");
	}
	if (!SHA_PATTERN.test(expectedSha)) invalid("expected SHA is invalid");
	if (!OWNER_PATTERN.test(expectedOwner)) invalid("expected owner is invalid");
	if (!ALLOWED_SCOPES.has(expectedScope)) invalid("expected scope is invalid");
	let contents;
	try {
		contents = await readFile(file, "utf8");
	} catch {
		invalid("record is unavailable");
	}
	let record;
	try {
		record = JSON.parse(contents);
	} catch {
		invalid("record is malformed JSON");
	}
	validateWaiver(record, expectedSha, expectedOwner, expectedScope);
	process.stdout.write(`valid release waiver: ${expectedSha} ${expectedScope}\n`);
}

main().catch((error) => {
	const reason = error instanceof Error ? error.message : "unknown validation failure";
	process.stderr.write(`invalid release waiver: ${reason}\n`);
	process.exitCode = 1;
});
