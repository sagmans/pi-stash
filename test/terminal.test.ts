import { strict as assert } from "node:assert";
import test from "node:test";

import { sanitizeTerminalLine, sanitizeTerminalText } from "../src/terminal.ts";

const ESC = "\u001b";
const BEL = "\u0007";
const C1_CSI = "\u009b";
const C1_DCS = "\u0090";
const C1_ST = "\u009c";
const BIDI_OVERRIDE = "\u202e";
const BIDI_ISOLATE = "\u2066";
const ZERO_WIDTH_SPACE = "\u200b";
const BOM = "\ufeff";

function containsTerminalControl(value: string): boolean {
	return /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

test("sanitizeTerminalText removes ANSI, OSC, controls, and bidi formatting", () => {
	const unsafe = `${ESC}[31mred${ESC}[0m ${ESC}]8;;https://evil.invalid${BEL}link${ESC}]8;;${BEL} ${C1_CSI}2J ${BIDI_OVERRIDE}abc${BIDI_ISOLATE}`;

	const safe = sanitizeTerminalText(unsafe);

	assert.equal(containsTerminalControl(safe), false);
	assert.equal(safe.includes("https://evil.invalid"), false);
	assert.ok(safe.includes("red"));
	assert.ok(safe.includes("link"));
	assert.ok(safe.includes("abc"));
});

test("sanitizeTerminalText removes 7-bit and 8-bit terminal control strings", () => {
	const unsafe = `before${ESC}Pprivate${ESC}\\after ${C1_DCS}secret${C1_ST}done`;

	const safe = sanitizeTerminalText(unsafe);

	assert.equal(safe, "beforeafter done");
});

test("sanitizeTerminalText preserves line structure and printable Unicode", () => {
	const safe = sanitizeTerminalText("first\rsecond\nCafe\u0301 👩‍💻\tlast");

	assert.equal(safe, "firstsecond\nCafe\u0301 👩‍💻    last");
});

test("sanitizeTerminalText replaces isolated surrogates and removes invisible separators", () => {
	const safe = sanitizeTerminalText(`a\ud800b${ZERO_WIDTH_SPACE}c${BOM}d`);

	assert.equal(safe, "a�bcd");
});

test("sanitizeTerminalLine cannot escape its assigned render row", () => {
	assert.equal(sanitizeTerminalLine("one\ntwo\rthree"), "one two three");
});
