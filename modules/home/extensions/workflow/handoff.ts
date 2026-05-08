import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface ManualHandoff {
	readonly command: string;
	readonly label: string;
	readonly reason: string;
}

export function prepareManualHandoff(ctx: ExtensionContext, handoff: ManualHandoff): string {
	ctx.ui.setEditorText(handoff.command);
	const text = [
		`${handoff.label}: manual handoff required.`,
		"Prepared handoff text in editor.",
		`Reason: ${handoff.reason}`,
		"Press Enter to run it, or edit/cancel it first.",
	].join("\n");
	ctx.ui.notify(text, "warning");
	return text;
}

export function unsafeAutomaticHandoffReason(): string {
	return "Pi extension sendUserMessage is fire-and-forget in this version; it cannot prove queue acceptance or slash-command execution.";
}
