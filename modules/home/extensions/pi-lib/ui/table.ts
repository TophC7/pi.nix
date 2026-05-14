import { Key, matchesKey } from "@mariozechner/pi-tui";
import type { TextStyle } from "./components.ts";
import type { UiComponentLike } from "./contracts.ts";
import { fitLine, padLine } from "./render.ts";

export interface SearchableTableColumn<T> {
	readonly header: string;
	readonly width?: number;
	readonly minWidth?: number;
	readonly render: (row: T) => string;
}

export interface SearchableTableOptions<T> {
	readonly rows: readonly T[];
	readonly columns: readonly SearchableTableColumn<T>[];
	readonly visibleRows?: number;
	readonly emptyLabel?: string;
	readonly getSearchText?: (row: T) => string;
	readonly accent?: TextStyle;
	readonly dim?: TextStyle;
	readonly selected?: TextStyle;
}

export class SearchableTable<T> implements UiComponentLike {
	private rows: readonly T[];
	private selectedIndex = 0;
	private scrollOffset = 0;
	private query = "";
	private visibleRowsOverride: number | undefined;

	constructor(private readonly options: SearchableTableOptions<T>) {
		this.rows = options.rows;
	}

	setRows(rows: readonly T[]): void {
		this.rows = rows;
		this.clampSelection();
	}

	setQuery(query: string): void {
		this.query = query;
		this.selectedIndex = 0;
		this.scrollOffset = 0;
		this.clampSelection();
	}

	getQuery(): string {
		return this.query;
	}

	setVisibleRows(visibleRows: number): void {
		this.visibleRowsOverride = Math.max(1, Math.floor(visibleRows));
	}

	selectedRow(): T | undefined {
		return this.filteredRows()[this.selectedIndex];
	}

	move(delta: number): void {
		const last = this.filteredRows().length - 1;
		if (last < 0) {
			this.selectedIndex = 0;
			this.scrollOffset = 0;
			return;
		}
		this.selectedIndex = Math.max(0, Math.min(last, this.selectedIndex + delta));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up) || data === "k") this.move(-1);
		else if (matchesKey(data, Key.down) || data === "j") this.move(1);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const rows = this.filteredRows();
		const visibleRows = Math.max(1, this.visibleRowsOverride ?? this.options.visibleRows ?? Math.min(8, rows.length || 1));
		this.clampSelection();
		this.syncOffset(visibleRows, rows.length);
		const columnWidths = computeColumnWidths(this.options.columns, safeWidth - 2);
		const lines: string[] = [];

		lines.push(this.renderHeader(columnWidths, safeWidth));
		lines.push(this.options.dim?.("─".repeat(safeWidth)) ?? "─".repeat(safeWidth));
		if (rows.length === 0) {
			lines.push(this.options.dim?.(fitLine(this.options.emptyLabel ?? "No rows", safeWidth)) ?? fitLine(this.options.emptyLabel ?? "No rows", safeWidth));
			return lines;
		}

		for (let i = 0; i < visibleRows; i++) {
			const row = rows[this.scrollOffset + i];
			if (!row) break;
			lines.push(this.renderRow(row, this.scrollOffset + i, columnWidths, safeWidth));
		}
		return lines;
	}

	invalidate(): void {}

	private filteredRows(): readonly T[] {
		const query = this.query.trim().toLowerCase();
		if (!query) return this.rows;
		const getSearchText = this.options.getSearchText ?? defaultSearchText(this.options.columns);
		return this.rows.filter((row) => getSearchText(row).toLowerCase().includes(query));
	}

	private renderHeader(columnWidths: readonly number[], width: number): string {
		const cells = this.options.columns.map((column, index) => padLine(column.header, columnWidths[index] ?? 1));
		return this.options.accent?.(fitLine(`  ${cells.join(" ")}`, width)) ?? fitLine(`  ${cells.join(" ")}`, width);
	}

	private renderRow(row: T, index: number, columnWidths: readonly number[], width: number): string {
		const prefix = index === this.selectedIndex ? "› " : "  ";
		const cells = this.options.columns.map((column, columnIndex) => fitLine(column.render(row), columnWidths[columnIndex] ?? 1));
		const line = fitLine(`${prefix}${cells.join(" ")}`, width);
		return index === this.selectedIndex ? this.options.selected?.(line) ?? line : line;
	}

	private clampSelection(): void {
		const last = this.filteredRows().length - 1;
		this.selectedIndex = Math.max(0, Math.min(Math.max(0, last), this.selectedIndex));
		if (last < 0) this.scrollOffset = 0;
	}

	private syncOffset(visibleRows: number, rowCount: number): void {
		if (rowCount <= 0) {
			this.scrollOffset = 0;
			return;
		}
		if (this.selectedIndex < this.scrollOffset) this.scrollOffset = this.selectedIndex;
		else if (this.selectedIndex >= this.scrollOffset + visibleRows) this.scrollOffset = this.selectedIndex - visibleRows + 1;
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, rowCount - visibleRows)));
	}
}

function computeColumnWidths<T>(columns: readonly SearchableTableColumn<T>[], width: number): number[] {
	const safeWidth = Math.max(1, width - Math.max(0, columns.length - 1));
	const fixed = columns.map((column) => column.width ?? 0);
	const fixedTotal = fixed.reduce((sum, value) => sum + value, 0);
	const flexibleIndexes = columns
		.map((column, index) => ({ column, index }))
		.filter(({ column }) => column.width === undefined)
		.map(({ index }) => index);
	const widths = fixed.map((value, index) => Math.max(columns[index]?.minWidth ?? 1, value));
	if (flexibleIndexes.length === 0) return widths.map((value) => Math.max(1, Math.min(value, safeWidth)));

	const remaining = Math.max(1, safeWidth - fixedTotal);
	const base = Math.max(1, Math.floor(remaining / flexibleIndexes.length));
	let extra = remaining - base * flexibleIndexes.length;
	for (const index of flexibleIndexes) {
		widths[index] = Math.max(columns[index]?.minWidth ?? 1, base + (extra > 0 ? 1 : 0));
		if (extra > 0) extra--;
	}
	return widths;
}

function defaultSearchText<T>(columns: readonly SearchableTableColumn<T>[]): (row: T) => string {
	return (row) => columns.map((column) => column.render(row)).join(" ");
}
