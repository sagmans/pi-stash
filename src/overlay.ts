// Stash overlay, built on pi's model-picker pattern.
//
// The component extends Container and composes pi-tui primitives (DynamicBorder,
// Text, Input, Spacer) exactly like ModelSelectorComponent, so it inherits the
// framed, themed, keybinding-respecting look users already know. Two extras the
// model picker lacks: a detail mode for previewing a multi-line draft, and a
// non-closing "drop" action.
//
// Pure helpers (relativeAge / listRow / headerLine / *Hint / detailLines) take a
// narrow OverlayTheme so they stay unit-testable without a terminal. The
// StashOverlayComponent wires those helpers into a mutable body container and
// drives list <-> detail mode swaps from handleInput.

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyText } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Focusable,
	getKeybindings,
	Input,
	type Keybinding,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalLine, sanitizeTerminalText } from "./terminal.ts";
import type { StashEntry } from "./types.ts";
import { entryLabel } from "./widget.ts";

export type OverlayTheme = Pick<Theme, "fg" | "bold">;
export type { ThemeColor };

/** Indexed item: `index` is the canonical stash position (0 = newest). */
export type IndexedEntry = { entry: StashEntry; index: number };

export type StashOverlayCallbacks = {
	onRestore(entry: StashEntry): void;
	onDrop(entry: StashEntry): Promise<boolean>;
	onClose(): void;
};

/** Keybinding matcher, injectable so tests avoid global keybinding state. */
export type KeyMatcher = (data: string, action: string) => boolean;

export const defaultKeyMatcher: KeyMatcher = (data, action) =>
	getKeybindings().matches(data, action as Keybinding);

const MAX_VISIBLE = 10;
const LABEL_WIDTH = 50;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Human-readable age, relative to `now`. Deterministic for tests. */
export function relativeAge(createdAt: number, now: number): string {
	const delta = Math.max(0, now - createdAt);
	if (delta < MINUTE) return "now";
	if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
	if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
	if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d`;
	return new Date(createdAt).toISOString().slice(0, 10);
}

/** One list row. Selected rows are accented and prefixed with a marker. */
export function listRow(
	item: IndexedEntry,
	selected: boolean,
	theme: OverlayTheme,
	labelWidth = LABEL_WIDTH,
): string {
	const prefix = selected ? theme.fg("accent", "▸ ") : "  ";
	const indexTag = theme.fg("dim", `[${item.index}]`);
	const label = entryLabel(item.entry, labelWidth);
	const body = selected ? theme.fg("accent", label) : label;
	const count = item.entry.assetCount ?? 0;
	const img = count > 0 ? ` ${theme.fg("success", `⬗${count}`)}` : "";
	const age = theme.fg("muted", relativeAge(item.entry.createdAt, Date.now()));
	return `${truncateToWidth(`${prefix}${indexTag} ${body}${img}`, labelWidth + 16)} ${age}`;
}

export function headerLine(count: number, cwdLabel: string, theme: OverlayTheme): string {
	const title = theme.fg("accent", theme.bold("Stash"));
	const tally = theme.fg("muted", `${count} draft${count === 1 ? "" : "s"}`);
	const where = theme.fg("dim", sanitizeTerminalLine(cwdLabel));
	return ` ${title}  ${tally}  ${where}`;
}

export function listFooter(theme: OverlayTheme): string {
	const up = keyText("tui.select.up" as Keybinding);
	const down = keyText("tui.select.down" as Keybinding);
	const confirm = keyText("tui.select.confirm" as Keybinding);
	const cancel = keyText("tui.select.cancel" as Keybinding);
	return theme.fg(
		"dim",
		` ${up}${down} move · ${confirm} restore · →/␣ preview · / filter · ${cancel} close`,
	);
}

export function detailFooter(theme: OverlayTheme): string {
	const confirm = keyText("tui.select.confirm" as Keybinding);
	const cancel = keyText("tui.select.cancel" as Keybinding);
	return theme.fg("dim", ` ${confirm} restore · d drop · ${cancel}/← back`);
}

export function detailHeader(item: IndexedEntry, theme: OverlayTheme): string {
	const title = theme.fg("accent", theme.bold(`[${item.index}] preview`));
	const count = item.entry.assetCount ?? 0;
	const img =
		count > 0 ? ` ${theme.fg("success", `⬗${count} image${count === 1 ? "" : "s"}`)}` : "";
	const age = theme.fg("muted", relativeAge(item.entry.createdAt, Date.now()));
	return ` ${title}${img}  ${age}`;
}

/** Lines for the detail body: optional message, then the full draft text. */
export function detailBody(item: IndexedEntry, theme: OverlayTheme): string[] {
	const lines: string[] = [];
	const message = item.entry.message?.trim();
	if (message) lines.push(theme.fg("muted", `note: ${sanitizeTerminalLine(message)}`));
	lines.push(theme.fg("text", sanitizeTerminalText(item.entry.text)));
	return lines;
}

export class StashOverlayComponent extends Container implements Focusable {
	private _focused = false;
	private readonly tui: { requestRender(): void };
	private readonly theme: OverlayTheme;
	private readonly cwdLabel: string;
	private readonly matches: KeyMatcher;
	private readonly callbacks: StashOverlayCallbacks;

	private items: IndexedEntry[];
	private filtered: IndexedEntry[];
	private selected = 0;
	private mode: "list" | "detail" = "list";
	private currentDetail: IndexedEntry | undefined;
	private dropInProgress = false;
	private cancelled = false;
	private pendingDrop: Promise<void> = Promise.resolve();

	private readonly searchInput: Input;
	private readonly headerText: Text;
	private readonly body: Container;
	private readonly footerText: Text;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		tui: { requestRender(): void },
		theme: OverlayTheme,
		entries: readonly StashEntry[],
		cwdLabel: string,
		callbacks: StashOverlayCallbacks,
		matches: KeyMatcher = defaultKeyMatcher,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.cwdLabel = cwdLabel;
		this.matches = matches;
		this.callbacks = callbacks;
		this.items = entries.map((entry, index) => ({ entry, index }));
		this.filtered = this.items;

		this.headerText = new Text(headerLine(this.items.length, this.cwdLabel, this.theme), 0, 0);
		this.searchInput = new Input();
		this.body = new Container();
		this.footerText = new Text(listFooter(this.theme), 0, 0);

		this.addChild(new DynamicBorder((s: string) => this.theme.fg("borderAccent", s)));
		this.addChild(new Spacer(1));
		this.addChild(this.headerText);
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.body);
		this.addChild(new Spacer(1));
		this.addChild(this.footerText);
		this.addChild(new DynamicBorder((s: string) => this.theme.fg("borderAccent", s)));

		this.updateBody();
	}

	handleInput(data: string): void {
		if (this.cancelled || this.dropInProgress) return;
		if (this.mode === "list") this.handleListInput(data);
		else this.handleDetailInput(data);
		this.tui.requestRender();
	}

	private handleListInput(data: string): void {
		const last = this.filtered.length - 1;
		if (this.matches(data, "tui.select.up")) {
			if (this.filtered.length) this.selected = this.selected === 0 ? last : this.selected - 1;
		} else if (this.matches(data, "tui.select.down")) {
			if (this.filtered.length) this.selected = this.selected === last ? 0 : this.selected + 1;
		} else if (this.matches(data, "tui.select.confirm")) {
			const selected = this.filtered[this.selected];
			if (selected) this.callbacks.onRestore(selected.entry);
		} else if (this.matches(data, "tui.select.cancel")) {
			this.callbacks.onClose();
		} else if (matchesKey(data, "right") || data === " ") {
			this.openDetail();
		} else {
			this.searchInput.handleInput(data);
			this.filter(this.searchInput.getValue());
		}
		this.updateBody();
	}

	private handleDetailInput(data: string): void {
		const current = this.currentDetail;
		if (!current) return;
		if (this.matches(data, "tui.select.confirm")) {
			this.callbacks.onRestore(current.entry);
		} else if (data === "d" && !this.dropInProgress) {
			this.pendingDrop = this.dropCurrent(current);
		} else if (this.matches(data, "tui.select.cancel") || matchesKey(data, "left")) {
			this.backToList();
		}
	}

	private filter(query: string): void {
		const q = query.trim().toLowerCase();
		this.filtered = q
			? this.items.filter((it) => {
					const hay = `${it.entry.text} ${it.entry.message ?? ""}`.toLowerCase();
					return q.split(/\s+/).every((token) => hay.includes(token));
				})
			: this.items;
		this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
	}

	private openDetail(): void {
		const item = this.filtered[this.selected];
		if (!item) return;
		this.mode = "detail";
		this.currentDetail = item;
		this.updateBody();
	}

	private backToList(): void {
		this.mode = "list";
		this.currentDetail = undefined;
		this.updateBody();
	}

	private async dropCurrent(current: IndexedEntry): Promise<void> {
		this.dropInProgress = true;
		try {
			if ((await this.callbacks.onDrop(current.entry)) && !this.cancelled) {
				this.removeEntry(current.index);
				this.backToList();
			}
		} finally {
			this.dropInProgress = false;
			if (!this.cancelled) this.tui.requestRender();
		}
	}

	cancel(): void {
		if (this.cancelled) return;
		this.cancelled = true;
		this.callbacks.onClose();
	}

	async settle(): Promise<void> {
		await this.pendingDrop;
	}

	private removeEntry(index: number): void {
		this.items = this.items
			.filter((item) => item.index !== index)
			.map((item, newIndex) => ({ ...item, index: newIndex }));
		this.filter(this.searchInput.getValue());
	}

	/** Rebuild the mutable body for whichever mode is active. */
	private updateBody(): void {
		this.headerText.setText(headerLine(this.items.length, this.cwdLabel, this.theme));
		this.body.clear();
		if (this.mode === "list") {
			this.footerText.setText(listFooter(this.theme));
			this.renderListBody();
		} else {
			this.footerText.setText(detailFooter(this.theme));
			this.renderDetailBody();
		}
	}

	private renderListBody(): void {
		if (this.filtered.length === 0) {
			this.body.addChild(new Text(this.theme.fg("muted", "  No matching drafts"), 0, 0));
			return;
		}
		const start = Math.max(
			0,
			Math.min(this.selected - Math.floor(MAX_VISIBLE / 2), this.filtered.length - MAX_VISIBLE),
		);
		const end = Math.min(start + MAX_VISIBLE, this.filtered.length);
		for (const [offset, item] of this.filtered.slice(start, end).entries()) {
			const index = start + offset;
			this.body.addChild(new Text(listRow(item, index === this.selected, this.theme), 0, 0));
		}
		if (start > 0 || end < this.filtered.length) {
			this.body.addChild(
				new Text(this.theme.fg("dim", `  (${this.selected + 1}/${this.filtered.length})`), 0, 0),
			);
		}
	}

	private renderDetailBody(): void {
		const item = this.currentDetail;
		if (!item) return;
		this.body.addChild(new Text(detailHeader(item, this.theme), 0, 0));
		this.body.addChild(new Spacer(1));
		for (const line of detailBody(item, this.theme)) {
			// Text wraps each paragraph at render width; no manual wrapping needed.
			this.body.addChild(new Text(line, 1, 0));
		}
		this.body.addChild(new Spacer(1));
		this.body.addChild(new Text(this.theme.fg("dim", `id ${item.entry.id.slice(0, 4)}`), 1, 0));
	}

	override invalidate(): void {
		// Rebuild themed content: caches hold ANSI from the prior theme.
		super.invalidate();
		this.updateBody();
	}
}
