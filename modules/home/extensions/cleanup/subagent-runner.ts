import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { runSubagent as runSharedSubagent } from "../subagent-runner.ts";

export { extractSubagentText } from "../subagent-runner.ts";
export type { SubagentParams, SubagentResponse } from "../subagent-runner.ts";

export async function runSubagent(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	params: Record<string, unknown>,
	label: string,
) {
	return runSharedSubagent(pi, ctx, params, label, "cleanup-subagents");
}
