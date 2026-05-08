import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const execFileAsync = promisify(execFile);
const APP_NAME = "Pi";
const NOTIFY_SEND = "@notifySend@";
const TIMEOUT_MS = Number(process.env.PI_NOTIFY_TIMEOUT_MS ?? 2500);

type Urgency = "low" | "normal" | "critical";

type Notification = {
	title: string;
	body: string;
	urgency?: Urgency;
};

let missingNotifierWarned = false;
let lastNotificationKey = "";
let lastNotificationAt = 0;
let notifierCache: { envKey: string; command: string | null } | undefined;

function enabled(): boolean {
	const value = process.env.PI_DESKTOP_NOTIFY;
	return value !== "0" && value !== "false" && value !== "off";
}

function notifierEnvKey(): string {
	return `${process.env.PI_NOTIFY_COMMAND ?? ""}\0${process.env.PATH ?? ""}\0${NOTIFY_SEND}`;
}

function commandCandidates(notification: Notification): Array<[string, string[]]> {
	const urgency = notification.urgency ?? "normal";
	const custom = process.env.PI_NOTIFY_COMMAND;
	const commands: Array<[string, string[]]> = [];

	if (custom) commands.push([custom, [notification.title, notification.body]]);

	commands.push(
		[
			NOTIFY_SEND,
			[
				"--app-name",
				APP_NAME,
				"--urgency",
				urgency,
				"--icon",
				"utilities-terminal",
				notification.title,
				notification.body,
			],
		],
		[
			"dunstify",
			[
				"--appname",
				APP_NAME,
				"--urgency",
				urgency,
				"--icon",
				"utilities-terminal",
				notification.title,
				notification.body,
			],
		],
		["kdialog", ["--title", notification.title, "--passivepopup", notification.body, "5"]],
		["zenity", ["--notification", `--title=${notification.title}`, `--text=${notification.body}`]],
	);

	return commands;
}

function shouldDeduplicate(notification: Notification): boolean {
	const now = Date.now();
	const key = `${notification.title}\n${notification.body}\n${notification.urgency ?? "normal"}`;
	const duplicate = key === lastNotificationKey && now - lastNotificationAt < 1500;
	lastNotificationKey = key;
	lastNotificationAt = now;
	return duplicate;
}

async function notifyDesktop(notification: Notification, ctx?: ExtensionContext): Promise<void> {
	if (!enabled() || shouldDeduplicate(notification)) return;

	const envKey = notifierEnvKey();
	const candidates = commandCandidates(notification);
	if (notifierCache?.envKey === envKey) {
		if (notifierCache.command === null) {
			warnMissingNotifier(ctx);
			return;
		}
		const cached = candidates.find(([command]) => command === notifierCache?.command);
		if (cached) {
			try {
				await execFileAsync(cached[0], cached[1], { timeout: TIMEOUT_MS });
				return;
			} catch {
				notifierCache = undefined;
			}
		}
	}

	for (const [command, args] of candidates) {
		try {
			await execFileAsync(command, args, { timeout: TIMEOUT_MS });
			notifierCache = { envKey, command };
			return;
		} catch {
			// Try next notifier.
		}
	}

	notifierCache = { envKey, command: null };
	warnMissingNotifier(ctx);
}

function warnMissingNotifier(ctx?: ExtensionContext): void {
	if (!missingNotifierWarned && ctx?.hasUI) {
		missingNotifierWarned = true;
		ctx.ui.notify("No desktop notifier found. Install libnotify/notify-send, dunstify, kdialog, or zenity.", "warning");
	}
}

function shortToolError(event: { toolName: string; result: unknown }): string {
	const result = event.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
	const text = result?.content?.find((item) => item?.type === "text")?.text?.trim();
	if (!text) return `${event.toolName} failed`;
	const firstLine = text.split("\n").find(Boolean) ?? `${event.toolName} failed`;
	return firstLine.length > 180 ? `${firstLine.slice(0, 177)}...` : firstLine;
}

export default function (pi: ExtensionAPI) {
	let startedAt = 0;
	let toolErrorCount = 0;
	let providerErrorCount = 0;
	let firstError = "";

	pi.registerCommand("desktop-notify-test", {
		description: "Send test Linux desktop notification",
		handler: async (_args, ctx) => {
			await notifyDesktop({ title: "Pi", body: "Desktop notifications working", urgency: "normal" }, ctx);
		},
	});

	pi.on("agent_start", async () => {
		startedAt = Date.now();
		toolErrorCount = 0;
		providerErrorCount = 0;
		firstError = "";
	});

	pi.on("after_provider_response", async (event, ctx) => {
		if (event.status < 400) return;
		providerErrorCount++;
		firstError ||= `Provider HTTP ${event.status}`;
		await notifyDesktop({ title: "Pi error", body: `Provider returned HTTP ${event.status}`, urgency: "critical" }, ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!event.isError) return;
		toolErrorCount++;
		const body = shortToolError(event);
		firstError ||= body;
		await notifyDesktop({ title: "Pi tool error", body, urgency: "critical" }, ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		const elapsedSeconds = startedAt ? Math.max(1, Math.round((Date.now() - startedAt) / 1000)) : 0;
		const suffix = elapsedSeconds ? ` (${elapsedSeconds}s)` : "";
		const totalErrors = toolErrorCount + providerErrorCount;

		if (totalErrors > 0) {
			await notifyDesktop(
				{
					title: "Pi finished with errors",
					body: `${totalErrors} error(s). ${firstError}${suffix}`,
					urgency: "critical",
				},
				ctx,
			);
			return;
		}

		if (ctx.hasPendingMessages()) {
			await notifyDesktop({ title: "Pi done", body: `Follow-up queued${suffix}`, urgency: "normal" }, ctx);
			return;
		}

		await notifyDesktop({ title: "Pi waiting for input", body: `Agent done${suffix}`, urgency: "normal" }, ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason === "quit") return;
		await notifyDesktop({ title: "Pi session", body: `Session ${event.reason}`, urgency: "low" }, ctx);
	});
}
