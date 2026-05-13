import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { fg, SLAB_ICONS, SLAB_PALETTES } from "./palette.ts";
import { renderSegment, SLAB_SEGMENT_BY_ID } from "./segments.ts";
import type {
	SlabConfig,
	SlabPalette,
	SlabRuntimeState,
	SlabSegmentRenderContext,
	SlabSegmentRenderResult,
	SlabWidthMode,
} from "./types.ts";
import type { UiRenderCapabilities, UiRenderClock } from "@pi/lib/ui";

const RESET = "\x1b[0m";

function widthModeFor(width: number): SlabWidthMode {
	if (width < 64) return "minimal";
	if (width < 96) return "compact";
	return "full";
}

function resolveShowProvider(config: SlabConfig, providerCount: number, widthMode: SlabWidthMode): boolean {
	if (config.display.showProvider === "always") return true;
	if (config.display.showProvider === "never") return false;
	return providerCount > 1 && widthMode === "full";
}

function styleSegment(segment: SlabSegmentRenderResult, palette: SlabPalette, text: string, color: boolean): string {
	if (!color) return text;
	if (segment.id === "context") {
		const match = text.match(/([0-9]+(?:\.[0-9]+)?)%/);
		const percent = match ? Number.parseFloat(match[1]!) : NaN;
		if (Number.isFinite(percent) && percent >= 90) return fg(palette.error, text);
		if (Number.isFinite(percent) && percent >= 75) return fg(palette.warn, text);
	}
	return fg(palette.segments[segment.id].fg, text);
}

function renderEnabledSegments(
	state: SlabRuntimeState,
	config: SlabConfig,
	width: number,
	capabilities: UiRenderCapabilities,
	clock: UiRenderClock,
	providerCount = state.providers.availableCount,
): { palette: SlabPalette; segments: SlabSegmentRenderResult[] } {
	const widthMode = config.display.adaptive ? widthModeFor(width) : "full";
	const palette = SLAB_PALETTES[config.theme];
	const icons = SLAB_ICONS[capabilities.unicode ? config.icons : "plain"];
	const ctx: SlabSegmentRenderContext = {
		state,
		config,
		widthMode,
		icons,
		showProvider: resolveShowProvider(config, providerCount, widthMode),
		render: { width, ...capabilities, ...clock },
	};
	const rendered: SlabSegmentRenderResult[] = [];
	for (const segmentConfig of config.segments) {
		if (!segmentConfig.enabled) continue;
		const definition = SLAB_SEGMENT_BY_ID.get(segmentConfig.id);
		if (!definition) continue;
		const result = renderSegment(ctx, definition);
		if (result) rendered.push(result);
	}
	return { palette, segments: rendered };
}

interface JoinedSegments {
	text: string;
	width: number;
}

function joinSegments(palette: SlabPalette, segments: SlabSegmentRenderResult[], color: boolean): JoinedSegments {
	if (segments.length === 0) return { text: "", width: 0 };
	const separator = color ? fg(palette.separator, " · ") : " · ";
	const text = `${segments.map((segment) => styleSegment(segment, palette, segment.text, color)).join(separator)}${color ? RESET : ""}`;
	return { text, width: visibleWidth(text) };
}

function fitSegments(palette: SlabPalette, segments: SlabSegmentRenderResult[], width: number, color: boolean): JoinedSegments {
	const fitted = [...segments];
	let joined = joinSegments(palette, fitted, color);
	while (fitted.length > 1 && joined.width > width) {
		fitted.pop();
		joined = joinSegments(palette, fitted, color);
	}
	return joined;
}

export function renderSlabLine(
	state: SlabRuntimeState,
	config: SlabConfig,
	width: number,
	capabilities: UiRenderCapabilities,
	clock: UiRenderClock,
	providerCount = state.providers.availableCount,
): string {
	if (!config.enabled) return "";
	const { palette, segments } = renderEnabledSegments(state, config, width, capabilities, clock, providerCount);
	const line = fitSegments(palette, segments, width, capabilities.color);
	if (line.width > width) {
		return truncateToWidth(line.text, width, capabilities.color ? fg(palette.dim, "…") : "…");
	}
	return line.text;
}
