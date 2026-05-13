import { truncateToWidth } from "@mariozechner/pi-tui";
import type { UiRenderCapabilities } from "@pi/lib/ui";
import { stripControls } from "./format.ts";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function clean(text: string, capabilities: UiRenderCapabilities): string {
	return capabilities.color ? text : text.replace(ANSI_PATTERN, "");
}

function fit(text: string, width: number, capabilities: UiRenderCapabilities): string {
	return truncateToWidth(clean(text, capabilities), Math.max(0, width), capabilities.unicode ? "…" : "...");
}

export function renderLegacyStatusRow(statuses: Iterable<string | undefined>, width: number, capabilities: UiRenderCapabilities): string | undefined {
	const values = [...statuses]
		.map((status) => stripControls(status ?? ""))
		.map((status) => status.trim())
		.filter(Boolean);
	if (values.length === 0) return undefined;
	const separator = capabilities.unicode ? " · " : " | ";
	const label = capabilities.unicode ? "compat │ " : "compat | ";
	return fit(`${label}${values.join(separator)}`, width, capabilities);
}

export function renderFooterBridgeLines(widgetLines: readonly string[], legacyStatuses: Iterable<string | undefined>, width: number, capabilities: UiRenderCapabilities): string[] {
	const lines = widgetLines.map((line) => fit(line, width, capabilities));
	const legacy = renderLegacyStatusRow(legacyStatuses, width, capabilities);
	if (legacy) lines.push(legacy);
	return lines;
}
