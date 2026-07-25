// Terminal-safe text normalization for every value that can originate in a
// draft, filesystem path, or persisted label. Escape protocols are parsed
// before control removal so payloads from OSC hyperlinks never leak into UI.

const ESCAPE = 0x1b;
const BEL = 0x07;
const ESCAPE_DCS = 0x50;
const ESCAPE_SOS = 0x58;
const ESCAPE_CSI = 0x5b;
const ESCAPE_ST = 0x5c;
const ESCAPE_OSC = 0x5d;
const ESCAPE_PM = 0x5e;
const ESCAPE_APC = 0x5f;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const DELETE = 0x7f;
const C1_START = 0x80;
const C1_DCS = 0x90;
const C1_SOS = 0x98;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const C1_OSC = 0x9d;
const C1_PM = 0x9e;
const C1_APC = 0x9f;
const C1_END = 0x9f;
const C1_CONTROL_STRINGS = new Set([C1_DCS, C1_SOS, C1_OSC, C1_PM, C1_APC]);
const C0_END = 0x20;
const CSI_FINAL_START = 0x40;
const CSI_FINAL_END = 0x7e;
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;
const REPLACEMENT_CHARACTER = "�";
const TAB_REPLACEMENT = "    ";
const SINGLE_LINE_BREAK_REPLACEMENT = " ";

const BIDI_AND_INVISIBLE = new Set([
	0x061c, 0x200b, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2066, 0x2067,
	0x2068, 0x2069, 0xfeff,
]);

export function sanitizeTerminalText(value: string): string {
	let safe = "";
	for (let index = 0; index < value.length; ) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit === ESCAPE) {
			index = skipEscapeSequence(value, index);
			continue;
		}
		if (codeUnit === C1_CSI) {
			index = skipCsi(value, index + 1);
			continue;
		}
		if (C1_CONTROL_STRINGS.has(codeUnit)) {
			index = skipControlString(value, index + 1);
			continue;
		}
		if (codeUnit === TAB) {
			safe += TAB_REPLACEMENT;
			index += 1;
			continue;
		}
		if (codeUnit === LINE_FEED) {
			safe += "\n";
			index += 1;
			continue;
		}
		if (codeUnit === CARRIAGE_RETURN || isControl(codeUnit)) {
			index += 1;
			continue;
		}
		if (isHighSurrogate(codeUnit)) {
			const next = value.charCodeAt(index + 1);
			if (!isLowSurrogate(next)) {
				safe += REPLACEMENT_CHARACTER;
				index += 1;
				continue;
			}
		} else if (isLowSurrogate(codeUnit)) {
			safe += REPLACEMENT_CHARACTER;
			index += 1;
			continue;
		}
		const codePoint = value.codePointAt(index) ?? codeUnit;
		const character = String.fromCodePoint(codePoint);
		if (!BIDI_AND_INVISIBLE.has(codePoint)) safe += character;
		index += character.length;
	}
	return safe;
}

export function sanitizeTerminalLine(value: string): string {
	return sanitizeTerminalText(value.replaceAll("\r", "\n")).replaceAll(
		"\n",
		SINGLE_LINE_BREAK_REPLACEMENT,
	);
}

function skipEscapeSequence(value: string, escapeIndex: number): number {
	const introducer = value.charCodeAt(escapeIndex + 1);
	if (introducer === ESCAPE_CSI) return skipCsi(value, escapeIndex + 2);
	if (introducer === ESCAPE_OSC) return skipControlString(value, escapeIndex + 2);
	if (
		introducer === ESCAPE_DCS ||
		introducer === ESCAPE_SOS ||
		introducer === ESCAPE_PM ||
		introducer === ESCAPE_APC
	) {
		return skipControlString(value, escapeIndex + 2);
	}
	return Math.min(value.length, escapeIndex + 2);
}

function skipCsi(value: string, start: number): number {
	let index = start;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		index += 1;
		if (code >= CSI_FINAL_START && code <= CSI_FINAL_END) return index;
	}
	return value.length;
}

function skipControlString(value: string, start: number): number {
	let index = start;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		if (code === BEL || code === C1_ST) return index + 1;
		if (code === ESCAPE && value.charCodeAt(index + 1) === ESCAPE_ST) return index + 2;
		index += 1;
	}
	return value.length;
}

function isControl(codeUnit: number): boolean {
	return codeUnit < C0_END || codeUnit === DELETE || (codeUnit >= C1_START && codeUnit <= C1_END);
}

function isHighSurrogate(codeUnit: number): boolean {
	return codeUnit >= HIGH_SURROGATE_START && codeUnit <= HIGH_SURROGATE_END;
}

function isLowSurrogate(codeUnit: number): boolean {
	return codeUnit >= LOW_SURROGATE_START && codeUnit <= LOW_SURROGATE_END;
}
