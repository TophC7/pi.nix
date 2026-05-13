import { Key, matchesKey } from "@mariozechner/pi-tui";
import type { UiComponentLike } from "@pi/lib/ui";
import {
	renderCenteredFrame,
	renderKeybindingFooter,
	renderProportionalBar,
	renderStackedSectionBar,
	SearchableTable,
} from "@pi/lib/ui";
import type { BurdenReport } from "./types.ts";
import { buildBurdenViewModel, type BurdenRowView, type BurdenViewModel } from "./view-model.ts";

export interface BurdenExplorerOptions {
	readonly report: BurdenReport;
	readonly onClose: () => void;
	readonly onOpenSource: (row: BurdenRowView) => string | void;
	readonly onOpenSnapshot?: (row: BurdenRowView) => string | void;
	readonly onToggleSkill: (row: BurdenRowView) => string | void;
	readonly accent?: (text: string) => string;
	readonly dim?: (text: string) => string;
	readonly warning?: (text: string) => string;
}

export class BurdenExplorer implements UiComponentLike {
	private readonly view: BurdenViewModel;
	private readonly expanded = new Set<string>();
	private readonly table: SearchableTable<BurdenRowView>;
	private searchMode = false;
	private detailRowId: string | undefined;
	private helpVisible = false;
	private status = "";

	constructor(private readonly options: BurdenExplorerOptions) {
		this.view = buildBurdenViewModel(options.report);
		for (const section of this.view.sections.slice(0, 4)) this.expanded.add(section.rowId);
		this.table = new SearchableTable({
			rows: this.visibleRows(),
			columns: [
				{ header: "Item", render: (row) => this.rowLabel(row), minWidth: 20 },
				{ header: "Source", render: (row) => row.sourceLabel, width: 24 },
				{ header: "Tokens", render: (row) => String(row.tokens), width: 8 },
				{ header: "%", render: (row) => percent(row.percentOfTotal), width: 6 },
			],
			visibleRows: 12,
			emptyLabel: "No burden rows match search.",
			getSearchText: (row) => row.searchText,
			accent: options.accent,
			dim: options.dim,
			selected: options.accent,
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c")) || data === "q") {
			this.options.onClose();
			return;
		}
		if (this.detailRowId) {
			this.handleDetailInput(data);
			return;
		}
		if (this.searchMode) {
			this.handleSearchInput(data);
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || data === "j" || data === "k") {
			this.table.handleInput(data);
		} else if (matchesKey(data, Key.enter)) {
			this.enterSelected();
		} else if (matchesKey(data, Key.right) || data === "l") {
			this.expandSelected();
		} else if (matchesKey(data, Key.left) || data === "h") {
			this.collapseSelected();
		} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.backspace)) {
			this.status = "Already at top level. Press q to close.";
		} else if (data === "/") {
			this.searchMode = true;
			this.status = "Search: type query, Esc to stop, Backspace to edit.";
		} else if (data === "e") {
			this.openSource();
		} else if (data === "s") {
			this.toggleSkill();
		} else if (data === "?") {
			this.helpVisible = !this.helpVisible;
		}
	}

	setStatus(status: string): void {
		this.status = status;
	}

	render(width: number): string[] {
		this.syncTableRows();
		const safeWidth = Math.max(32, width);
		const innerWidth = Math.max(20, Math.min(100, safeWidth - 6));
		const body = this.detailRowId ? this.detailBody(innerWidth) : this.tableBody(innerWidth);
		return renderCenteredFrame(safeWidth, {
			title: `Burden — ${this.view.totalTokens} tok${this.view.contextWindow ? ` / ${this.view.contextWindow} ctx` : ""}`,
			body,
			status: this.status || undefined,
			footer: this.footer(),
			maxWidth: 110,
			accent: this.options.accent,
			dim: this.options.dim,
		});
	}

	invalidate(): void {}

	private tableBody(width: number): string[] {
		const contextBar = renderProportionalBar([
			{ label: "used", value: this.view.totalTokens, style: this.options.accent },
			{ label: "free", value: Math.max(0, (this.view.contextWindow ?? this.view.totalTokens) - this.view.totalTokens), char: "░", style: this.options.dim },
		], { width: Math.max(10, width - 18) });
		const summary = [
			`Generated ${this.view.generatedAt}`,
			`Context ${contextBar} ${this.view.contextPercent === undefined ? "n/a" : percent(this.view.contextPercent)}`,
		];
		const sections = renderStackedSectionBar(
			this.view.sections.map((section) => ({ label: section.label, value: section.tokens, style: this.options.accent })),
			{ width, valueFormatter: (value) => `${value} tok`, emptyLabel: "No sections" },
		).slice(0, 5);
		const query = this.table.getQuery();
		const searchLine = query || this.searchMode ? `Search: ${query}${this.searchMode ? "_" : ""}` : "Search: /";
		return [
			...summary,
			"",
			...sections,
			"",
			this.style(searchLine, this.searchMode ? this.options.accent : this.options.dim),
			...this.table.render(width),
			...this.helpLines(),
		];
	}

	private detailBody(width: number): string[] {
		const row = this.detailRow();
		if (!row) return ["No detail row selected."];
		return row.detailLines.map((line) => line.length === 0 ? "" : line).slice(0, 40);
	}

	private footer(): string {
		if (this.detailRowId) {
			return renderKeybindingFooter([
				{ key: "Esc/Backspace", label: "back" },
				{ key: "e", label: "source" },
				{ key: "q", label: "close" },
			], { accent: this.options.accent, dim: this.options.dim });
		}
		return renderKeybindingFooter([
			{ key: "↑↓/j/k", label: "move" },
			{ key: "Enter", label: "detail/snapshot" },
			{ key: "→/l", label: "expand" },
			{ key: "←/h", label: "collapse" },
			{ key: "/", label: "search" },
			{ key: "e", label: "source" },
			{ key: "s", label: "skill" },
			{ key: "q", label: "close" },
		], { accent: this.options.accent, dim: this.options.dim });
	}

	private helpLines(): string[] {
		if (!this.helpVisible) return [];
		return [
			"",
			this.style("Help", this.options.accent),
			"Enter opens generated detail/snapshot when content exists; otherwise it expands rows with children.",
			"Rows with source + content + children: e opens source; Enter opens detail/snapshot; →/l expands.",
			"Esc/Backspace backs out of search/detail. q closes.",
		];
	}

	private handleSearchInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
			this.searchMode = false;
			this.status = this.table.getQuery() ? "Search filter active." : "Search cleared.";
		} else if (matchesKey(data, Key.backspace)) {
			this.table.setQuery(this.table.getQuery().slice(0, -1));
		} else if (data.length === 1 && data >= " ") {
			this.table.setQuery(`${this.table.getQuery()}${data}`);
		}
	}

	private handleDetailInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.backspace)) {
			this.detailRowId = undefined;
			this.status = "Back to table.";
		} else if (data === "e") {
			this.openSource(this.detailRow());
		}
	}

	private enterSelected(): void {
		const row = this.table.selectedRow();
		if (!row) return;
		if (row.actions.openSnapshot) {
			const status = this.options.onOpenSnapshot?.(row);
			if (!this.options.onOpenSnapshot) this.detailRowId = row.id;
			this.status = status ?? `Opened detail for ${row.label}.`;
			return;
		}
		if (row.hasChildren) this.toggleExpanded(row);
		else this.status = "No detail or children for selected row.";
	}

	private expandSelected(): void {
		const row = this.table.selectedRow();
		if (!row?.hasChildren) {
			this.status = "Selected row has no children.";
			return;
		}
		this.expanded.add(row.id);
		this.status = `Expanded ${row.label}.`;
		this.syncTableRows();
	}

	private collapseSelected(): void {
		const row = this.table.selectedRow();
		if (!row?.hasChildren || !this.expanded.has(row.id)) {
			this.status = "Selected row is not expanded.";
			return;
		}
		this.expanded.delete(row.id);
		this.status = `Collapsed ${row.label}.`;
		this.syncTableRows();
	}

	private toggleExpanded(row: BurdenRowView): void {
		if (this.expanded.has(row.id)) this.expanded.delete(row.id);
		else this.expanded.add(row.id);
		this.status = `${this.expanded.has(row.id) ? "Expanded" : "Collapsed"} ${row.label}.`;
		this.syncTableRows();
	}

	private openSource(row = this.table.selectedRow()): void {
		if (!row?.actions.openSource) {
			this.status = "No source path for selected row.";
			return;
		}
		this.status = this.options.onOpenSource(row) ?? `Opening ${row.actions.openSource.path}`;
	}

	private toggleSkill(): void {
		const row = this.table.selectedRow();
		if (!row?.actions.toggleSkill) {
			this.status = "Selected row is not a toggleable skill.";
			return;
		}
		this.status = this.options.onToggleSkill(row) ?? "Skill toggled. Use /reload or restart for prompt changes.";
	}

	private visibleRows(): BurdenRowView[] {
		const query = this.table?.getQuery() ?? "";
		if (query.trim()) return [...this.view.rows];
		return this.view.rows.filter((row) => this.isVisible(row));
	}

	private isVisible(row: BurdenRowView): boolean {
		let parentId = row.parentId;
		while (parentId) {
			if (!this.expanded.has(parentId)) return false;
			parentId = this.view.rowsById.get(parentId)?.parentId;
		}
		return true;
	}

	private syncTableRows(): void {
		this.table.setRows(this.visibleRows());
	}

	private detailRow(): BurdenRowView | undefined {
		return this.detailRowId ? this.view.rowsById.get(this.detailRowId) : undefined;
	}

	private rowLabel(row: BurdenRowView): string {
		const indent = "  ".repeat(row.depth);
		const fold = row.hasChildren ? (this.expanded.has(row.id) ? "▾" : "▸") : " ";
		const source = row.actions.openSource ? " [e]" : "";
		const snapshot = row.actions.openSnapshot ? " [↵]" : "";
		const skill = row.actions.toggleSkill ? " [s]" : "";
		return `${indent}${fold} ${row.label}${source}${snapshot}${skill}`;
	}

	private style(text: string, style: ((text: string) => string) | undefined): string {
		return style ? style(text) : text;
	}
}

function percent(value: number): string {
	return `${Math.round(value * 1000) / 10}%`;
}
