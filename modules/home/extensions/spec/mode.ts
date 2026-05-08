import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { workflowController } from "../workflow/controller.ts";
import { getWorkflowProfile } from "../workflow/profiles.ts";
import { restoreWorkflowTools } from "../workflow/tools.ts";
import type { WorkflowProfile } from "../workflow/types.ts";
import type { Mode, ModeState } from "./types.ts";

export const state: ModeState = { mode: "idle" };

function profileForMode(mode: Mode): WorkflowProfile | undefined {
	if (mode === "idle") return undefined;
	return getWorkflowProfile(mode);
}

export function setWorkflowStatus(ctx: ExtensionContext, mode: Mode): void {
	if (mode === "idle") {
		ctx.ui.setStatus("spec-workflow", undefined);
		ctx.ui.setWidget("spec-workflow", undefined);
		return;
	}
	ctx.ui.setStatus("spec-workflow", mode);
	ctx.ui.setWidget("spec-workflow", [`Pi spec workflow: ${mode}`]);
}

export function enterMode(pi: ExtensionAPI, ctx: ExtensionContext, mode: Mode): void {
	if (mode === "idle") return exitMode(pi, ctx);
	if (state.mode === mode) return;
	const profile = profileForMode(mode);
	if (!profile) throw new Error(`Missing workflow profile for ${mode}`);
	const run = workflowController.enter(pi, ctx, profile);
	state.mode = mode;
	state.snapshot = [...run.previousActiveTools];
}

export function exitMode(pi: ExtensionAPI, ctx: ExtensionContext): void {
	try {
		if (workflowController.activeRun) {
			workflowController.exit(pi, ctx);
		} else if (state.snapshot) {
			restoreWorkflowTools(pi, { previousActiveTools: state.snapshot });
			setWorkflowStatus(ctx, "idle");
		}
	} finally {
		state.mode = "idle";
		state.snapshot = undefined;
	}
}

export function maybeBlockAuthoringToolCall(event: { toolName?: string; input?: unknown }) {
	const profile = profileForMode(state.mode);
	if (!profile) return;
	if (profile.safety.blocksFileMutationTools && (event.toolName === "write" || event.toolName === "edit")) {
		return { block: true, reason: `${event.toolName} blocked during ${state.mode}; use workflow save tools.` };
	}
	if (!profile.safety.blocksMutatingShell || event.toolName !== "bash") return;
	const input = event.input as { command?: unknown };
	if (typeof input.command !== "string") return;
	const blocked = profile.safety.blockedBash.find((rule) => rule.pattern.test(input.command));
	if (blocked) {
		return { block: true, reason: `Mutating shell command blocked during ${state.mode}: ${blocked.reason}.` };
	}
}
