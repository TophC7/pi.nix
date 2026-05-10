import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { WorkflowId, WorkflowProfile } from "./types.ts";
import { activateWorkflowTools, restoreWorkflowTools, type WorkflowToolActivation } from "./tools.ts";

export type WorkflowControllerStatus = "idle" | "entering" | "active" | "awaiting_confirmation" | "continuation_queued" | "manual_pending" | "exiting" | "failed_resetting";
export type WorkflowMarkerStatus = WorkflowControllerStatus | (string & {});

export interface WorkflowErrorDetails {
	readonly name: string;
	readonly message: string;
}

export interface WorkflowMarker {
	readonly runId: string;
	readonly profileId: WorkflowId;
	readonly status: WorkflowMarkerStatus;
	readonly previousActiveTools?: readonly string[];
	readonly activeTools?: readonly string[];
	readonly reason?: string;
	readonly error?: WorkflowErrorDetails;
	readonly timestamp: string;
}

export interface WorkflowRun {
	readonly runId: string;
	readonly profile: WorkflowProfile;
	readonly startedAt: number;
	readonly previousActiveTools: readonly string[];
	status: WorkflowControllerStatus;
	activation?: WorkflowToolActivation;
	lastError?: WorkflowErrorDetails;
}

export class WorkflowTransitionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowTransitionError";
	}
}

export class WorkflowController {
	private currentRun: WorkflowRun | undefined;

	get status(): WorkflowControllerStatus {
		return this.currentRun?.status ?? "idle";
	}

	get activeRun(): WorkflowRun | undefined {
		return this.currentRun;
	}

	enter(pi: ExtensionAPI, ctx: ExtensionContext, profile: WorkflowProfile): WorkflowRun {
		if (this.currentRun && this.currentRun.status !== "idle") {
			throw new WorkflowTransitionError(`Cannot enter ${profile.id}; workflow ${this.currentRun.profile.id} is ${this.currentRun.status}.`);
		}

		const previousActiveTools = pi.getActiveTools();
		const run: WorkflowRun = {
			runId: randomUUID(),
			profile,
			startedAt: Date.now(),
			previousActiveTools,
			status: "entering",
		};
		this.currentRun = run;
		this.render(ctx, run);
		this.persist(pi, run, "entering");

		try {
			run.activation = activateWorkflowTools(pi, profile);
			run.status = "active";
			this.render(ctx, run);
			this.persist(pi, run, "active");
			return run;
		} catch (error) {
			this.resetAfterFailure(pi, ctx, run, formatError(error), errorDetails(error));
			throw error;
		}
	}

	markAwaitingConfirmation(pi: ExtensionAPI, ctx: ExtensionContext, reason?: string): void {
		const run = this.requireRun("mark awaiting confirmation");
		if (run.status !== "active") {
			throw new WorkflowTransitionError(`Cannot mark awaiting confirmation from ${run.status}; expected active.`);
		}
		run.status = "awaiting_confirmation";
		this.render(ctx, run);
		this.persist(pi, run, reason ?? "awaiting_confirmation");
	}

	markContinuationQueued(pi: ExtensionAPI, ctx: ExtensionContext, reason?: string): void {
		const run = this.requireRun("mark continuation queued");
		if (run.status !== "active" && run.status !== "awaiting_confirmation") {
			throw new WorkflowTransitionError(`Cannot mark continuation queued from ${run.status}; expected active or awaiting_confirmation.`);
		}
		run.status = "continuation_queued";
		this.render(ctx, run);
		this.persist(pi, run, reason ?? "continuation_queued");
	}

	markManualPending(pi: ExtensionAPI, ctx: ExtensionContext, reason?: string): void {
		const run = this.requireRun("mark manual pending");
		if (run.status !== "active" && run.status !== "awaiting_confirmation") {
			throw new WorkflowTransitionError(`Cannot mark manual pending from ${run.status}; expected active or awaiting_confirmation.`);
		}
		run.status = "manual_pending";
		this.render(ctx, run);
		this.persist(pi, run, reason ?? "manual_pending");
	}

	exit(pi: ExtensionAPI, ctx: ExtensionContext, reason = "normal_exit"): void {
		const run = this.requireRun("exit");
		run.status = "exiting";
		this.render(ctx, run);
		this.persist(pi, run, reason);
		try {
			this.restore(pi, run);
			this.clear(pi, ctx, run, reason);
		} catch (error) {
			run.lastError = errorDetails(error);
			run.status = "failed_resetting";
			this.render(ctx, run);
			this.persist(pi, run, formatError(error));
			this.clear(pi, ctx, run, `restore_failed:${formatError(error)}`);
			throw error;
		}
	}

	cancel(pi: ExtensionAPI, ctx: ExtensionContext, reason = "cancelled"): void {
		const run = this.requireRun("cancel");
		this.resetAfterFailure(pi, ctx, run, reason);
	}

	fail(pi: ExtensionAPI, ctx: ExtensionContext, error: unknown): void {
		const run = this.requireRun("fail");
		this.resetAfterFailure(pi, ctx, run, formatError(error), errorDetails(error));
	}

	private requireRun(action: string): WorkflowRun {
		if (!this.currentRun || this.currentRun.status === "idle") {
			throw new WorkflowTransitionError(`Cannot ${action}; no active workflow.`);
		}
		return this.currentRun;
	}

	private resetAfterFailure(pi: ExtensionAPI, ctx: ExtensionContext, run: WorkflowRun, reason: string, error?: WorkflowErrorDetails): void {
		run.lastError = error;
		run.status = "failed_resetting";
		this.render(ctx, run);
		this.persist(pi, run, reason);
		try {
			this.restore(pi, run);
			this.clear(pi, ctx, run, reason);
		} catch (restoreError) {
			run.lastError = errorDetails(restoreError);
			this.render(ctx, run);
			this.persist(pi, run, formatError(restoreError));
			this.clear(pi, ctx, run, `restore_failed:${formatError(restoreError)}`);
			throw restoreError;
		}
	}

	private restore(pi: ExtensionAPI, run: WorkflowRun): void {
		restoreWorkflowTools(pi, run.activation ?? { previousActiveTools: run.previousActiveTools });
	}

	private clear(pi: ExtensionAPI, ctx: ExtensionContext, run: WorkflowRun, reason: string): void {
		this.currentRun = undefined;
		this.clearStatus(ctx, run.profile);
		this.persist(pi, { ...run, status: "idle" }, reason);
	}

	private render(ctx: ExtensionContext, run: WorkflowRun): void {
		ctx.ui.setStatus(run.profile.statusKey, `${run.profile.id}:${run.status}`);
		ctx.ui.setWidget(run.profile.statusKey, [`Pi workflow: ${run.profile.label}`, `Status: ${run.status}`]);
	}

	private clearStatus(ctx: ExtensionContext, profile: WorkflowProfile): void {
		ctx.ui.setStatus(profile.statusKey, undefined);
		ctx.ui.setWidget(profile.statusKey, undefined);
	}

	private persist(pi: ExtensionAPI, run: WorkflowRun, reason: string): void {
		if (!run.profile.persistence.persistMarker) return;
		const marker: WorkflowMarker = {
			runId: run.runId,
			profileId: run.profile.id,
			status: run.status,
			previousActiveTools: run.profile.persistence.persistToolSnapshot ? (run.activation?.previousActiveTools ?? run.previousActiveTools) : undefined,
			activeTools: run.activation?.activeAfterSet,
			reason,
			error: run.lastError,
			timestamp: new Date().toISOString(),
		};
		pi.appendEntry(run.profile.persistence.markerType, marker);
	}
}

export const workflowController = new WorkflowController();

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorDetails(error: unknown): WorkflowErrorDetails {
	if (error instanceof Error) return { name: error.name, message: error.message };
	return { name: "Error", message: String(error) };
}
