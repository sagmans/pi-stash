// Searchable stash overlay with cancellable refresh/drop settlement.
// Pure render helpers keep terminal behavior testable without a live TUI.

import {
	type Component,
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
import { keyText, StashBorder, type StashKeybindings, type Theme } from "./host.ts";
import { sanitizeTerminalLine, sanitizeTerminalText } from "./terminal.ts";
import type { StashEntry } from "./types.ts";
import { entryLabel } from "./widget.ts";

export type OverlayTheme = Pick<Theme, "fg" | "bold">;

/** Indexed item: `index` is the canonical stash position (0 = newest). */
export type IndexedEntry = { entry: StashEntry; index: number };

export type StashOverlayCallbacks = {
	onPop(entry: StashEntry): void;
	onDrop(entry: StashEntry): Promise<boolean>;
	onRefresh(): Promise<readonly StashEntry[]>;
	onRefreshError(error: unknown): void;
	onClose(): void;
};

const MAX_VISIBLE = 10;
const LABEL_WIDTH = 50;
const PREVIEW_VIEWPORT_ROWS = 10;
const PREVIEW_PAGE_ROWS = PREVIEW_VIEWPORT_ROWS - 1;
const EMPTY_DRAFT_LABEL = "(empty draft)";
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
export function listRow(item: IndexedEntry, selected: boolean, theme: OverlayTheme): string {
	const prefix = selected ? theme.fg("accent", "▸ ") : "  ";
	const indexTag = theme.fg("dim", `[${item.index}]`);
	const label = entryLabel(item.entry, LABEL_WIDTH);
	const body = selected ? theme.fg("accent", label) : label;
	const count = item.entry.assetCount ?? 0;
	const img = count > 0 ? ` ${theme.fg("success", `⬗${count}`)}` : "";
	const age = theme.fg("muted", relativeAge(item.entry.createdAt, Date.now()));
	return `${truncateToWidth(`${prefix}${indexTag} ${body}${img}`, LABEL_WIDTH + 16)} ${age}`;
}

export function headerLine(count: number, cwdLabel: string, theme: OverlayTheme): string {
	const title = theme.fg("accent", theme.bold("Stash"));
	const tally = theme.fg("muted", `${count} draft${count === 1 ? "" : "s"}`);
	const where = theme.fg("dim", sanitizeTerminalLine(cwdLabel));
	return ` ${title}  ${tally}  ${where}`;
}

export function listFooter(
	theme: OverlayTheme,
	keybindings: StashKeybindings = getKeybindings(),
): string {
	const up = keyText("tui.select.up" as Keybinding, keybindings);
	const down = keyText("tui.select.down" as Keybinding, keybindings);
	const confirm = keyText("tui.select.confirm" as Keybinding, keybindings);
	const preview = keyText("tui.input.tab" as Keybinding, keybindings);
	const cancel = keyText("tui.select.cancel" as Keybinding, keybindings);
	return theme.fg(
		"dim",
		` ${up}${down} move · ${confirm} pop · ${preview} preview · F5 refresh · type to filter · ${cancel} close`,
	);
}

export function detailFooter(
	theme: OverlayTheme,
	keybindings: StashKeybindings = getKeybindings(),
): string {
	const up = keyText("tui.select.up" as Keybinding, keybindings);
	const down = keyText("tui.select.down" as Keybinding, keybindings);
	const pageUp = keyText("tui.select.pageUp" as Keybinding, keybindings);
	const pageDown = keyText("tui.select.pageDown" as Keybinding, keybindings);
	const confirm = keyText("tui.select.confirm" as Keybinding, keybindings);
	const cancel = keyText("tui.select.cancel" as Keybinding, keybindings);
	return theme.fg(
		"dim",
		` d drop · ${confirm} pop · ${up}${down} scroll · ${pageUp}/${pageDown} page · F5 refresh · Home/End bounds · ${cancel}/← back`,
	);
}

export function detailHeader(item: IndexedEntry, theme: OverlayTheme): string {
	const title = theme.fg("accent", theme.bold(`[${item.index}] preview`));
	const count = item.entry.assetCount ?? 0;
	const img =
		count > 0 ? ` ${theme.fg("success", `⬗${count} image${count === 1 ? "" : "s"}`)}` : "";
	const age = theme.fg("muted", relativeAge(item.entry.createdAt, Date.now()));
	return ` ${title}${img}  ${age}`;
}

/** Lines for the detail body: optional label, then the full draft text. */
export function detailBody(item: IndexedEntry, theme: OverlayTheme): string[] {
	const lines: string[] = [];
	const label = item.entry.label?.trim();
	if (label) lines.push(theme.fg("muted", `label: ${sanitizeTerminalLine(label)}`));
	const text = sanitizeTerminalText(item.entry.text);
	lines.push(theme.fg("text", text.length > 0 ? text : EMPTY_DRAFT_LABEL));
	return lines;
}

class DraftPreviewComponent implements Component {
	private readonly content: Text;
	private readonly theme: OverlayTheme;
	private readonly keybindings: StashKeybindings;
	private offset = 0;
	private lineCount = 0;
	private pinnedToEnd = false;

	constructor(content: string, theme: OverlayTheme, keybindings: StashKeybindings) {
		this.content = new Text(content, 1, 0);
		this.theme = theme;
		this.keybindings = keybindings;
	}

	scroll(lines: number): void {
		this.pinnedToEnd = false;
		this.offset = Math.max(0, this.offset + lines);
		this.clampOffset();
	}

	page(direction: -1 | 1): void {
		this.scroll(direction * PREVIEW_PAGE_ROWS);
	}

	toStart(): void {
		this.pinnedToEnd = false;
		this.offset = 0;
	}

	toEnd(): void {
		this.pinnedToEnd = true;
	}

	render(width: number): string[] {
		const contentLines = this.content.render(width);
		this.lineCount = contentLines.length;
		if (this.pinnedToEnd) this.offset = this.maxOffset();
		else this.clampOffset();

		const viewport = contentLines.slice(this.offset, this.offset + PREVIEW_VIEWPORT_ROWS);
		const blank = " ".repeat(Math.max(0, width));
		while (viewport.length < PREVIEW_VIEWPORT_ROWS) viewport.push(blank);
		const first = this.lineCount === 0 ? 0 : this.offset + 1;
		const last = Math.min(this.lineCount, this.offset + PREVIEW_VIEWPORT_ROWS);
		const position = this.theme.fg("dim", ` lines ${first}–${last}/${this.lineCount}`);
		return [
			truncateToWidth(detailFooter(this.theme, this.keybindings), width, "…", true),
			truncateToWidth(position, width, "…", true),
			...viewport,
		];
	}

	invalidate(): void {
		this.content.invalidate();
	}

	private clampOffset(): void {
		this.offset = Math.min(this.offset, this.maxOffset());
	}

	private maxOffset(): number {
		return Math.max(0, this.lineCount - PREVIEW_VIEWPORT_ROWS);
	}
}

type DetailState = {
	item: IndexedEntry;
	preview: DraftPreviewComponent;
};

export class StashOverlayComponent extends Container implements Focusable {
	private _focused = false;
	private readonly tui: { requestRender(): void };
	private readonly theme: OverlayTheme;
	private readonly cwdLabel: string;
	private readonly keybindings: StashKeybindings;
	private readonly callbacks: StashOverlayCallbacks;

	private items: IndexedEntry[];
	private filtered: IndexedEntry[];
	private selected = 0;
	private query = "";
	private detail: DetailState | undefined;
	private dropInProgress = false;
	private cancelled = false;
	private pendingDrop: Promise<void> = Promise.resolve();
	private readonly pendingRefreshes = new Set<Promise<void>>();
	private refreshGeneration = 0;

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
		keybindings: StashKeybindings = getKeybindings(),
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.cwdLabel = cwdLabel;
		this.keybindings = keybindings;
		this.callbacks = callbacks;
		this.items = entries.map((entry, index) => ({ entry, index }));
		this.filtered = this.items;

		this.headerText = new Text(headerLine(this.items.length, this.cwdLabel, this.theme), 0, 0);
		this.searchInput = new Input();
		this.body = new Container();
		this.footerText = new Text(listFooter(this.theme, this.keybindings), 0, 0);

		this.addChild(new StashBorder((text) => this.theme.fg("borderAccent", text)));
		this.addChild(new Spacer(1));
		this.addChild(this.headerText);
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.body);
		this.addChild(new Spacer(1));
		this.addChild(this.footerText);
		this.addChild(new StashBorder((text) => this.theme.fg("borderAccent", text)));

		this.updateBody();
	}

	handleInput(data: string): void {
		if (this.cancelled || this.dropInProgress) return;
		if (matchesKey(data, "f5")) {
			this.requestRefresh();
		} else if (this.detail) this.handleDetailInput(data);
		else this.handleListInput(data);
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
			if (selected) this.callbacks.onPop(selected.entry);
		} else if (this.matches(data, "tui.select.cancel")) {
			this.callbacks.onClose();
		} else if (this.matches(data, "tui.input.tab")) {
			this.openDetail();
		} else {
			this.searchInput.handleInput(data);
			this.filter(this.searchInput.getValue());
		}
		this.updateBody();
	}

	private handleDetailInput(data: string): void {
		const detail = this.detail;
		if (!detail) return;
		const { item: current, preview } = detail;
		if (this.matches(data, "tui.select.confirm")) {
			this.callbacks.onPop(current.entry);
		} else if (data === "d" && !this.dropInProgress) {
			this.pendingDrop = this.dropCurrent(current);
		} else if (this.matches(data, "tui.select.cancel") || matchesKey(data, "left")) {
			this.backToList();
		} else if (this.matches(data, "tui.select.up")) {
			preview.scroll(-1);
		} else if (this.matches(data, "tui.select.down")) {
			preview.scroll(1);
		} else if (this.matches(data, "tui.select.pageUp")) {
			preview.page(-1);
		} else if (this.matches(data, "tui.select.pageDown")) {
			preview.page(1);
		} else if (matchesKey(data, "home")) {
			preview.toStart();
		} else if (matchesKey(data, "end")) {
			preview.toEnd();
		}
	}

	private filter(query: string): void {
		const queryChanged = query !== this.query;
		this.query = query;
		const normalized = query.trim().toLowerCase();
		this.filtered = normalized
			? this.items.filter((it) => {
					const hay = `${it.entry.text} ${it.entry.label ?? ""}`.toLowerCase();
					return normalized.split(/\s+/).every((token) => hay.includes(token));
				})
			: this.items;
		this.selected = queryChanged
			? 0
			: Math.min(this.selected, Math.max(0, this.filtered.length - 1));
	}

	private createDetail(item: IndexedEntry): DetailState {
		return {
			item,
			preview: new DraftPreviewComponent(
				detailBody(item, this.theme).join("\n"),
				this.theme,
				this.keybindings,
			),
		};
	}

	private openDetail(): void {
		const item = this.filtered[this.selected];
		if (!item) return;
		this.detail = this.createDetail(item);
		this.updateBody();
	}

	private backToList(): void {
		this.detail = undefined;
		this.updateBody();
	}

	private async dropCurrent(current: IndexedEntry): Promise<void> {
		this.dropInProgress = true;
		try {
			if ((await this.callbacks.onDrop(current.entry)) && !this.cancelled) {
				this.removeEntry(current.index);
				this.backToList();
				await this.refreshEntries();
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
		while (this.pendingRefreshes.size > 0) {
			await Promise.all([...this.pendingRefreshes]);
		}
	}

	private requestRefresh(): void {
		const pending = this.refreshEntries();
		this.pendingRefreshes.add(pending);
		void pending.finally(() => this.pendingRefreshes.delete(pending));
	}

	private async refreshEntries(): Promise<void> {
		const generation = ++this.refreshGeneration;
		try {
			const entries = await this.callbacks.onRefresh();
			if (this.cancelled || generation !== this.refreshGeneration) return;
			this.replaceEntries(entries);
			this.tui.requestRender();
		} catch (error) {
			if (!this.cancelled && generation === this.refreshGeneration) {
				this.callbacks.onRefreshError(error);
			}
		}
	}

	private replaceEntries(entries: readonly StashEntry[]): void {
		const selectedId = this.detail?.item.entry.id ?? this.filtered[this.selected]?.entry.id;
		this.items = entries.map((entry, index) => ({ entry, index }));
		this.filter(this.searchInput.getValue());
		const selected = this.filtered.findIndex((item) => item.entry.id === selectedId);
		if (selected >= 0) this.selected = selected;

		if (this.detail) {
			const refreshedDetail = this.items.find((item) => item.entry.id === selectedId);
			this.detail = refreshedDetail ? this.createDetail(refreshedDetail) : undefined;
		}
		this.updateBody();
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
		if (!this.detail) {
			this.footerText.setText(listFooter(this.theme, this.keybindings));
			this.renderListBody();
		} else {
			// Preview controls live above the scroll viewport so max-height clipping
			// cannot hide pop/drop guidance below a long draft.
			this.footerText.setText("");
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
		const detail = this.detail;
		if (!detail) return;
		this.body.addChild(new Text(detailHeader(detail.item, this.theme), 0, 0));
		this.body.addChild(
			new Text(this.theme.fg("dim", ` id ${detail.item.entry.id.slice(0, 4)}`), 0, 0),
		);
		this.body.addChild(detail.preview);
	}

	private matches(data: string, action: string): boolean {
		return this.keybindings.matches(data, action as Keybinding);
	}

	override invalidate(): void {
		// Rebuild themed content: caches hold ANSI from the prior theme.
		super.invalidate();
		if (this.detail) this.detail = this.createDetail(this.detail.item);
		this.updateBody();
	}
}
