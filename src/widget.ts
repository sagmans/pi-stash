// Pure renderer for the above-editor stash widget.
//
// Returns the exact line set to hand to ctx.ui.setWidget("pi-stash", lines).
// An empty array means "clear the widget": the caller is expected to call
// setWidget with `undefined` when there is nothing to show, keeping the editor
// area uncluttered when no stash exists.

import { truncateToWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine, sanitizeTerminalText } from "./terminal.ts";
import type { StashEntry } from "./types.ts";

export const MAX_WIDGET_ENTRIES = 5;
const DEFAULT_PREVIEW_WIDTH = 60;
const DEFAULT_OPEN_HINT = "prefix+shift+s to open";

export type RenderOptions = {
	/** False suppresses a shortcut hint when no binding provider is active. */
	openHint?: string | false;
	previewWidth?: number;
	maxEntries?: number;
	width?: number;
};

export function firstNonEmptyLine(text: string): string {
	for (const line of sanitizeTerminalText(text).split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length > 0) return trimmed;
	}
	return "";
}

export function truncateForWidget(value: string, width: number): string {
	const truncated = truncateToWidth(sanitizeTerminalLine(value), Math.max(0, width), "…");
	return sanitizeTerminalLine(truncated);
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

	const configuredHint = options.openHint ?? DEFAULT_OPEN_HINT;
	const openHint = configuredHint === false ? undefined : sanitizeTerminalLine(configuredHint);
	const previewWidth = options.previewWidth ?? DEFAULT_PREVIEW_WIDTH;
	const requestedEntries = options.maxEntries ?? MAX_WIDGET_ENTRIES;
	const maxEntries = Number.isFinite(requestedEntries)
		? Math.max(0, Math.floor(requestedEntries))
		: MAX_WIDGET_ENTRIES;
	const details = openHint ? `(${openHint}) · ${entries.length}` : String(entries.length);

	const header = ` ${theme.fg("accent", "Stash")} ${theme.fg("muted", details)}`;
	const lines: string[] = [header];
	const visibleCount = Math.min(entries.length, maxEntries);

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

	if (options.width === undefined) return lines;
	const width = Math.max(0, Math.floor(options.width));
	return lines.map((line) => truncateToWidth(line, width, "…"));
}
