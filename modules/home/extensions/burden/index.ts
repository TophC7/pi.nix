import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { centeredOverlayOptions } from "@pi/lib/ui";
import { buildBurdenReport } from "./attribution.ts";
import { BurdenExplorer } from "./explorer.ts";
import { openBurdenSnapshot, openBurdenSource } from "./source-actions.ts";
import { toggleSkillDisabled } from "./skills.ts";
import type { BurdenRowView } from "./view-model.ts";

export const BURDEN_COMMAND = "burden" as const;

export default function burden(pi: ExtensionAPI): void {
	pi.registerCommand(BURDEN_COMMAND, {
		description: "Open first-party token attribution explorer",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const report = buildBurdenReport(pi, ctx);
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				let explorer: BurdenExplorer | undefined;
				const requestRender = () => tui.requestRender();
				const setStatus = (status: string) => {
					explorer?.setStatus(status);
					requestRender();
				};
				const openSource = (row: BurdenRowView) => {
					const result = openBurdenSource(row, { onStatus: setStatus, requestRender });
					requestRender();
					return result.status;
				};
				const openSnapshot = (row: BurdenRowView) => {
					const result = openBurdenSnapshot(row, { onStatus: setStatus, requestRender });
					requestRender();
					return result.status;
				};
				const toggleSkill = (row: BurdenRowView) => {
					const skillPath = row.actions.toggleSkill?.path;
					if (!skillPath) return "Selected row is not a toggleable skill.";
					try {
						const result = toggleSkillDisabled(skillPath);
						requestRender();
						return `Skill ${row.label} ${result.disabled ? "disabled" : "enabled"}. Use /reload or restart for prompt changes.`;
					} catch (error) {
						requestRender();
						return `Failed to toggle skill ${row.label}: ${error instanceof Error ? error.message : String(error)}`;
					}
				};
				explorer = new BurdenExplorer({
					report,
					onClose: () => done(undefined),
					onOpenSource: openSource,
					onOpenSnapshot: openSnapshot,
					onToggleSkill: toggleSkill,
					accent: (text) => theme.fg("accent", theme.bold(text)),
					dim: (text) => theme.fg("dim", text),
					warning: (text) => theme.fg("warning", text),
				});
				return explorer;
			}, centeredOverlayOptions({ width: "90%", maxHeight: "85%" }));
		},
	});
}
