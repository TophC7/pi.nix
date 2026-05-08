import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { maybeBlockAuthoringToolCall, setWorkflowStatus, state } from "./mode.ts";
import { registerPlanCommands, registerSpecCommands } from "./commands.ts";
import { registerSpecWorkflowTools } from "./tools.ts";

export default function specWorkflowExtension(pi: ExtensionAPI) {
	registerSpecWorkflowTools(pi);

	pi.on("session_start", (_event, ctx) => {
		if (state.mode !== "idle") setWorkflowStatus(ctx, state.mode);
	});

	pi.on("tool_call", maybeBlockAuthoringToolCall);

	registerPlanCommands(pi);
	registerSpecCommands(pi);
	pi.on("resources_discover", () => {
		if (!existsSync(".sworm")) return;
		return {};
	});
}
