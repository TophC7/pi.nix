import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerSubagentTool, shouldRegisterLocalSubagentTool } from "./tool.ts";

export default function subagentsExtension(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		// Safe cutover guard: register local tool only when no active tool named
		// `subagent` exists, preserving exactly one model-facing owner.
		if (shouldRegisterLocalSubagentTool(pi)) registerSubagentTool(pi);
	});
}
