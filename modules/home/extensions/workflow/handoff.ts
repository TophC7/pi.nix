import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { workflowController } from "./controller.ts";

export interface ManualHandoff {
	readonly command: string;
	readonly label: string;
	readonly reason: string;
}

export type HandoffOutcome = "accepted" | "edit" | "cancelled";

export interface HandoffPrepareOptions {
	readonly pi?: ExtensionAPI;
}

export interface HandoffResult {
	readonly outcome: HandoffOutcome;
	readonly notice: string;
}

export async function prepareManualHandoff(
	ctx: ExtensionContext,
	handoff: ManualHandoff,
	options: HandoffPrepareOptions = {},
): Promise<HandoffResult> {
	const choice = await chooseHandoffAction(ctx, handoff);
	if (choice === "cancel") return finalize(ctx, options.pi, handoff, "cancelled", `${handoff.label}: handoff cancelled by user. Workflow remains in handoff_pending until rerun.`);
	if (choice === "preview") {
		ctx.ui.notify(`${handoff.label}: handoff preview\n${handoff.reason}\n\n${handoff.command}`, "info");
		return prepareManualHandoff(ctx, handoff, options);
	}
	if (choice === "edit") return finalize(ctx, options.pi, handoff, "edit", placeIntoEditor(ctx, handoff, "Edit before running, then press Enter."));
	return finalize(ctx, options.pi, handoff, "accepted", placeIntoEditor(ctx, handoff, "Press Enter to run it, or edit/cancel it first."));
}

export function unsafeAutomaticHandoffReason(): string {
	return "Pi extension sendUserMessage is fire-and-forget in this version; it cannot prove queue acceptance or slash-command execution.";
}

async function chooseHandoffAction(ctx: ExtensionContext, handoff: ManualHandoff): Promise<"accept" | "edit" | "preview" | "cancel"> {
	if (typeof ctx.ui.select !== "function") return "accept";
	const labels = ["accept and stage", "edit before staging", "preview", "cancel"] as const;
	const choice = await ctx.ui.select(`${handoff.label}: how do you want to handle the manual handoff?`, [...labels]);
	if (choice === "edit before staging") return "edit";
	if (choice === "preview") return "preview";
	if (choice === "cancel") return "cancel";
	return "accept";
}

function placeIntoEditor(ctx: ExtensionContext, handoff: ManualHandoff, instruction: string): string {
	ctx.ui.setEditorText(handoff.command);
	const text = [
		`${handoff.label}: manual handoff staged.`,
		`Reason: ${handoff.reason}`,
		instruction,
	].join("\n");
	ctx.ui.notify(text, "warning");
	return text;
}

function finalize(ctx: ExtensionContext, pi: ExtensionAPI | undefined, handoff: ManualHandoff, outcome: HandoffOutcome, notice: string): HandoffResult {
	if (pi && workflowController.activeRun && workflowController.status === "active") {
		try {
			workflowController.markHandoffPending(pi, ctx, `${handoff.label}: ${outcome}`);
		} catch (error) {
			ctx.ui.notify(`Failed to mark workflow handoff_pending: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}
	return { outcome, notice };
}
