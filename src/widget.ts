// Pure renderer for the above-editor stash widget.
//
// Returns the exact line set to hand to ctx.ui.setWidget("pi-stash", lines).
// An empty array means "clear the widget": the caller is expected to call
// setWidget with `undefined` when there is nothing to show, keeping the editor
// area uncluttered when no stash exists.

import { sanitizeTerminalLine, sanitizeTerminalText } from "./terminal.ts";
import type { StashEntry } from "./types.ts";

export const MAX_WIDGET_LINES = 5;
const DEFAULT_PREVIEW_WIDTH = 60;
const DEFAULT_OPEN_HINT = "prefix+shift+s to open";

export type RenderOptions = {
	openHint?: string;
	previewWidth?: number;
	maxLines?: number;
};

export function firstNonEmptyLine(text: string): string {
	for (const line of sanitizeTerminalText(text).split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length > 0) return trimmed;
	}
	return "";
}

export function truncateForWidget(value: string, width: number): string {
	if (value.length <= width) return value;
	return `${value.slice(0, Math.max(1, width - 1))}…`;
}

export function entryLabel(entry: StashEntry, previewWidth: number): string {
	const label = entry.message?.trim() || firstNonEmptyLine(entry.text) || "(empty draft)";
	return truncateForWidget(sanitizeTerminalLine(label), previewWidth);
}

export function renderWidgetLines(
	entries: readonly StashEntry[],
	options: RenderOptions = {},
): string[] {
	return themedWidgetLines(entries, { fg: (_color, text) => text }, options);
}

export type WidgetTheme = { fg(color: string, text: string): string };

/** Theme-colored widget lines. Header/count/marker/label each get their own color
 * so the strip matches the rest of the TUI instead of printing raw text. */
export function themedWidgetLines(
	entries: readonly StashEntry[],
	theme: WidgetTheme,
	options: RenderOptions = {},
): string[] {
	if (entries.length === 0) return [];

	const openHint = sanitizeTerminalLine(options.openHint ?? DEFAULT_OPEN_HINT);
	const previewWidth = options.previewWidth ?? DEFAULT_PREVIEW_WIDTH;
	const maxLines = options.maxLines ?? MAX_WIDGET_LINES;

	const header = ` ${theme.fg("accent", "Stash")} ${theme.fg("muted", `(${openHint}) · ${entries.length}`)}`;
	const lines: string[] = [header];
	const visibleCount = Math.min(entries.length, maxLines);

	for (const [index, entry] of entries.slice(0, visibleCount).entries()) {
		const count = entry.assetCount ?? 0;
		const marker = count > 0 ? `${theme.fg("success", "[img]")} ` : "      ";
		const idx = theme.fg("dim", `[${index}]`);
		const label = theme.fg("muted", entryLabel(entry, previewWidth));
		lines.push(` ${idx} ${marker}${label}`);
	}

	if (entries.length > visibleCount) {
		lines.push(theme.fg("dim", ` … +${entries.length - visibleCount} more`));
	}

	return lines;
}
