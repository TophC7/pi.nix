import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { paint, paintIf, rainbowRole } from "./palette.ts";
import { renderSegment, SLAB_SEGMENT_BY_ID } from "./segments.ts";
import type {
	SlabConfig,
	SlabRuntimeState,
	SlabSegmentId,
	SlabSegmentRenderContext,
	SlabSegmentRenderResult,
	SlabWidthMode,
} from "./types.ts";
import type { UiRenderCapabilities, UiRenderClock } from "@pi/lib/ui";

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

function styleSegment(text: string, color: boolean, order: number): string {
	if (!color) return text;
	return paint(rainbowRole(order), text);
}

export interface SlabSegmentFilter {
	include?: readonly SlabSegmentId[];
	exclude?: readonly SlabSegmentId[];
}

function passesFilter(id: SlabSegmentId, filter: SlabSegmentFilter | undefined): boolean {
	if (!filter) return true;
	if (filter.include && !filter.include.includes(id)) return false;
	if (filter.exclude && filter.exclude.includes(id)) return false;
	return true;
}

function renderEnabledSegments(
	state: SlabRuntimeState,
	config: SlabConfig,
	width: number,
	capabilities: UiRenderCapabilities,
	clock: UiRenderClock,
	providerCount: number,
	filter: SlabSegmentFilter | undefined,
): SlabSegmentRenderResult[] {
	const widthMode = config.display.adaptive ? widthModeFor(width) : "full";
	const ctx: SlabSegmentRenderContext = {
		state,
		config,
		widthMode,
		showProvider: resolveShowProvider(config, providerCount, widthMode),
		render: { width, ...capabilities, ...clock },
	};
	const rendered: SlabSegmentRenderResult[] = [];
	for (const segmentConfig of config.segments) {
		if (!segmentConfig.enabled) continue;
		if (!passesFilter(segmentConfig.id, filter)) continue;
		const definition = SLAB_SEGMENT_BY_ID.get(segmentConfig.id);
		if (!definition) continue;
		const result = renderSegment(ctx, definition);
		if (result) rendered.push(result);
	}
	return rendered;
}

interface JoinedSegments {
	text: string;
	width: number;
}

function joinSegments(segments: SlabSegmentRenderResult[], color: boolean, colorOffset: number): JoinedSegments {
	if (segments.length === 0) return { text: "", width: 0 };
	const separator = paintIf(color, "dim", " · ");
	const text = segments.map((segment, index) => styleSegment(segment.text, color, colorOffset + index)).join(separator);
	return { text, width: visibleWidth(text) };
}

function fitSegments(segments: SlabSegmentRenderResult[], width: number, color: boolean, colorOffset: number): JoinedSegments {
	const fitted = [...segments];
	let joined = joinSegments(fitted, color, colorOffset);
	while (fitted.length > 1 && joined.width > width) {
		fitted.pop();
		joined = joinSegments(fitted, color, colorOffset);
	}
	return joined;
}

export interface RenderSlabLineOptions extends SlabSegmentFilter {
	providerCount?: number;
	colorOffset?: number;
}

export function renderSlabLine(
	state: SlabRuntimeState,
	config: SlabConfig,
	width: number,
	capabilities: UiRenderCapabilities,
	clock: UiRenderClock,
	options: RenderSlabLineOptions = {},
): string {
	if (!config.enabled) return "";
	const providerCount = options.providerCount ?? state.providers.availableCount;
	const segments = renderEnabledSegments(state, config, width, capabilities, clock, providerCount, options);
	const line = fitSegments(segments, width, capabilities.color, options.colorOffset ?? 0);
	if (line.width > width) {
		return truncateToWidth(line.text, width, capabilities.color ? paint("dim", "…") : "…");
	}
	return line.text;
}
