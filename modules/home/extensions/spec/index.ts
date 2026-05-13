import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { setWorkflowStatus, setupAuthoringGuard, state } from "./mode.ts";
import { registerPlanCommands, registerSpecCommands } from "./commands.ts";
import { registerPlanReviewCommand } from "./review-command.ts";
import { registerSpecWorkflowTools } from "./tools.ts";
import { formatWorkflowPermissionsSnapshot, getWorkflowPermissionsSnapshot, recoverStaleWorkflow } from "@pi/lib/workflow";
import { MODES, type Mode } from "./types.ts";

export default function specWorkflowExtension(pi: ExtensionAPI) {
	registerSpecWorkflowTools(pi);

	pi.on("session_start", (_event, ctx) => {
		const recovery = recoverStaleWorkflow(pi, ctx);
		if (recovery.action === "safe_reset") {
			state.mode = "idle";
			state.snapshot = undefined;
			return;
		}
		if (recovery.action === "failed" && isSpecMode(recovery.marker?.profileId)) {
			state.mode = recovery.marker.profileId;
			state.snapshot = undefined;
			setWorkflowStatus(ctx, state.mode);
			return;
		}
		if (state.mode !== "idle") setWorkflowStatus(ctx, state.mode);
	});

	setupAuthoringGuard(pi);

	registerPlanCommands(pi);
	registerPlanReviewCommand(pi);
	registerSpecCommands(pi);
	pi.registerCommand("permissions", {
		description: "Show current workflow permission and active-tool state.",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatWorkflowPermissionsSnapshot(getWorkflowPermissionsSnapshot(pi)), "info");
		},
	});
	pi.on("resources_discover", () => {
		if (!existsSync(".sworm")) return;
		return {};
	});
}

function isSpecMode(value: unknown): value is Mode {
	return typeof value === "string" && MODES.includes(value as Mode) && value !== "idle";
}
