import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { workflowController } from "./controller.ts";
import { getWorkflowProfile, SAFE_DEFAULT_TOOLS } from "./profiles.ts";
import { restoreWorkflowTools } from "./tools.ts";
import type { WorkflowId, WorkflowProfile } from "./types.ts";

export type AuthoringGuardMode<TMode extends WorkflowId> = "idle" | TMode;

export interface AuthoringGuardState<TMode extends WorkflowId> {
	mode: AuthoringGuardMode<TMode>;
	snapshot?: string[];
}

export interface AuthoringGuardOptions<TMode extends WorkflowId> {
	readonly modes: readonly TMode[];
	readonly statusKey: string;
	readonly statusLabel: string;
}

export interface AuthoringToolCallEvent {
	readonly toolName?: string;
	readonly input?: unknown;
}

export interface AuthoringToolCallBlock {
	readonly block: true;
	readonly reason: string;
}

export interface AuthoringGuard<TMode extends WorkflowId> {
	readonly state: AuthoringGuardState<TMode>;
	setWorkflowStatus(ctx: ExtensionContext, mode: AuthoringGuardMode<TMode>): void;
	enterMode(pi: ExtensionAPI, ctx: ExtensionContext, mode: AuthoringGuardMode<TMode>): void;
	exitMode(pi: ExtensionAPI, ctx: ExtensionContext): void;
	maybeBlockAuthoringToolCall(event: AuthoringToolCallEvent): AuthoringToolCallBlock | undefined;
	setupAuthoringGuard(pi: ExtensionAPI): void;
}

export function createAuthoringGuard<TMode extends WorkflowId>(options: AuthoringGuardOptions<TMode>): AuthoringGuard<TMode> {
	const state: AuthoringGuardState<TMode> = { mode: "idle" };
	const modes = new Set<string>(options.modes);

	function profileForMode(mode: AuthoringGuardMode<TMode>): WorkflowProfile | undefined {
		if (mode === "idle") return undefined;
		if (!modes.has(mode)) throw new Error(`Mode ${mode} is not managed by this authoring guard.`);
		return getWorkflowProfile(mode);
	}

	function setWorkflowStatus(ctx: ExtensionContext, mode: AuthoringGuardMode<TMode>): void {
		if (mode === "idle") {
			ctx.ui.setStatus(options.statusKey, undefined);
			ctx.ui.setWidget(options.statusKey, undefined);
			return;
		}
		ctx.ui.setStatus(options.statusKey, mode);
		ctx.ui.setWidget(options.statusKey, [`${options.statusLabel}: ${mode}`]);
	}

	function enterMode(pi: ExtensionAPI, ctx: ExtensionContext, mode: AuthoringGuardMode<TMode>): void {
		if (mode === "idle") return exitMode(pi, ctx);
		if (state.mode === mode) return;
		const profile = profileForMode(mode);
		if (!profile) throw new Error(`Missing workflow profile for ${mode}`);
		const run = workflowController.enter(pi, ctx, profile);
		state.mode = mode;
		state.snapshot = [...run.previousActiveTools];
	}

	function exitMode(pi: ExtensionAPI, ctx: ExtensionContext): void {
		try {
			if (workflowController.activeRun) {
				workflowController.exit(pi, ctx);
				return;
			}
			const targetTools = state.snapshot ?? safeDefaultToolsAvailable(pi);
			try {
				restoreWorkflowTools(pi, { previousActiveTools: targetTools });
			} catch (error) {
				ctx.ui.notify(`Workflow exit fallback restore failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		} finally {
			setWorkflowStatus(ctx, "idle");
			state.mode = "idle";
			state.snapshot = undefined;
		}
	}

	function maybeBlockAuthoringToolCall(event: AuthoringToolCallEvent): AuthoringToolCallBlock | undefined {
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

	function setupAuthoringGuard(pi: ExtensionAPI): void {
		pi.on("tool_call", maybeBlockAuthoringToolCall);
	}

	return {
		state,
		setWorkflowStatus,
		enterMode,
		exitMode,
		maybeBlockAuthoringToolCall,
		setupAuthoringGuard,
	};
}

function safeDefaultToolsAvailable(pi: ExtensionAPI): readonly string[] {
	const all = new Set(pi.getAllTools().map((tool) => tool.name));
	return SAFE_DEFAULT_TOOLS.filter((name) => all.has(name));
}
