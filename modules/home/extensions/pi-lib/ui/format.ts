// ABOUT: Compact human-readable formatters used by status text and labels.
// Moved here from subagents/render-helpers.ts as part of the §T051 dependency
// cleanup so UI consumers (slab/format.ts, future status text helpers) can
// consume formatters without crossing into the subagents package.

export function formatTokens(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens <= 0) return "0";
	if (tokens >= 1_000_000) return `${trimUnit(tokens / 1_000_000)}M`;
	if (tokens >= 1_000) return `${trimUnit(tokens / 1_000)}k`;
	return String(Math.round(tokens));
}

/** Alias kept for consumers that prefer the more explicit name. */
export const formatTokenCount = formatTokens;

function trimUnit(value: number): string {
	return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}
