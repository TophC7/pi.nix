import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { DashboardMeta, SpecInfo, TaskSummary, TrekkerResult } from "./types.ts";
import { readSpecFiles } from "./spec-files.ts";

export async function runTrekker(pi: ExtensionAPI, args: string[], ctx: ExtensionContext): Promise<TrekkerResult> {
	const result = await pi.exec("trekker", args, { cwd: ctx.cwd, signal: ctx.signal });
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 1 };
}

function extractSpecTaskIds(spec: SpecInfo): string[] {
	const content = readSpecFiles(spec);
	return [...new Set([...content.matchAll(/\|\s*(TASK-\d+)\s*\|/g)].map((match) => match[1]).filter(Boolean))];
}

export function summarizeTasks(spec: SpecInfo, taskOutput: string, readyOutput: string, commentsOutput = ""): TaskSummary {
	const counts: Record<string, number> = { todo: 0, in_progress: 0, completed: 0, wont_fix: 0, archived: 0 };
	const specTag = `spec:${spec.name}`;
	const lines = taskOutput.split("\n").filter((line) => line.includes(specTag));
	for (const line of lines) {
		const status = line.match(/\|\s*(todo|in_progress|completed|wont_fix|archived)\s*\|/)?.[1];
		if (status) counts[status] = (counts[status] ?? 0) + 1;
	}
	const readyLine = readyOutput.split("\n").find((line) => /TASK-\d+/.test(line) && line.includes(specTag)) ?? "none";
	const blockers = commentsOutput.split("\n").filter((line) => /blocker|BLOCKER/i.test(line)).slice(0, 5);
	const manualChecks = commentsOutput.split("\n").filter((line) => /manual/i.test(line)).slice(0, 5);
	return { counts, readyLine, blockers, manualChecks };
}

export async function collectSpecComments(pi: ExtensionAPI, spec: SpecInfo, ctx: ExtensionContext): Promise<string> {
	const outputs: string[] = [];
	for (const id of extractSpecTaskIds(spec).slice(0, 100)) {
		const result = await runTrekker(pi, ["comment", "list", id, "--limit", "50"], ctx);
		if (result.code === 0 && result.stdout.trim()) outputs.push(`${id}\n${result.stdout}`);
	}
	return outputs.join("\n");
}

export async function collectSpecTaskOutput(pi: ExtensionAPI, spec: SpecInfo, ctx: ExtensionContext): Promise<string> {
	const ids = new Set(extractSpecTaskIds(spec));
	const outputs: string[] = [];
	for (const status of ["todo", "in_progress", "completed", "wont_fix", "archived"]) {
		const result = await runTrekker(pi, ["task", "list", "--status", status, "--limit", "500"], ctx);
		if (result.code !== 0) continue;
		for (const line of result.stdout.split("\n")) {
			const id = line.match(/^(TASK-\d+)\s*\|/)?.[1];
			if (id && ids.has(id)) outputs.push(`${id} | ${status} | [spec:${spec.name}]`);
		}
	}
	return outputs.join("\n");
}

export function formatCounts(counts: Record<string, number>): string {
	return ["completed", "in_progress", "todo", "wont_fix", "archived"].map((status) => `${counts[status] ?? 0} ${status}`).join(", ");
}

async function findFreePort(start = 3000): Promise<number> {
	for (let port = start; port < start + 20; port++) {
		const free = await new Promise<boolean>((resolveFree) => {
			const server = createServer();
			server.once("error", () => resolveFree(false));
			server.once("listening", () => server.close(() => resolveFree(true)));
			server.listen(port, "127.0.0.1");
		});
		if (free) return port;
	}
	throw new Error("No free dashboard port found near 3000.");
}

export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function urlHealthy(url: string | undefined): Promise<boolean> {
	if (!url) return false;
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 1000);
		const response = await fetch(url, { signal: controller.signal });
		clearTimeout(timeout);
		return response.ok;
	} catch {
		return false;
	}
}

export function readDashboardMeta(path: string): DashboardMeta {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as DashboardMeta;
	} catch {
		return {};
	}
}

async function openTrekkerDashboard(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const dir = ".sworm/trekker";
	const pidPath = join(dir, "dashboard.pid");
	const jsonPath = join(dir, "dashboard.json");
	mkdirSync(dir, { recursive: true });
	if (!existsSync(join(dir, "trekker.db"))) {
		ctx.ui.notify("Missing .sworm/trekker/trekker.db. Next: trekker init --epic-prefix SPEC --issue-prefix TASK --comment-prefix NOTE", "error");
		return;
	}
	const meta = readDashboardMeta(jsonPath);
	const pidFromFile = existsSync(pidPath) ? Number(readFileSync(pidPath, "utf8").trim()) : undefined;
	const pid = Number.isFinite(meta.pid) ? meta.pid : pidFromFile;
	if (typeof pid === "number" && processAlive(pid) && await urlHealthy(meta.url)) {
		ctx.ui.notify(`Trekker dashboard already running: ${meta.url}\nStop: /trekker stop`, "info");
		void pi.exec("xdg-open", [meta.url ?? `http://localhost:${meta.port ?? 3000}`], { cwd: ctx.cwd, timeout: 5000 });
		return;
	}
	if (existsSync(pidPath)) rmSync(pidPath, { force: true });
	if (existsSync(jsonPath)) rmSync(jsonPath, { force: true });
	const port = await findFreePort(3000);
	const child = spawn("trekker-dashboard", ["-p", String(port)], { cwd: ctx.cwd, detached: true, stdio: "ignore" });
	child.unref();
	const url = `http://localhost:${port}`;
	writeFileSync(pidPath, `${child.pid}\n`);
	writeFileSync(jsonPath, `${JSON.stringify({ pid: child.pid, port, url, startedAt: new Date().toISOString() }, null, 2)}\n`);
	const opened = await pi.exec("xdg-open", [url], { cwd: ctx.cwd, timeout: 5000 });
	const browserNote = (opened.code ?? 1) === 0 ? "browser opened" : `browser open failed; open manually: ${url}`;
	ctx.ui.notify(`Trekker dashboard: ${url}\nPID: ${child.pid}\nStop: /trekker stop\n${browserNote}`, "info");
}

function stopTrekkerDashboard(ctx: ExtensionCommandContext): void {
	const dir = ".sworm/trekker";
	const pidPath = join(dir, "dashboard.pid");
	const jsonPath = join(dir, "dashboard.json");
	const meta = readDashboardMeta(jsonPath);
	const pidFromFile = existsSync(pidPath) ? Number(readFileSync(pidPath, "utf8").trim()) : undefined;
	const pid = Number.isFinite(meta.pid) ? meta.pid : pidFromFile;
	if (typeof pid === "number" && processAlive(pid)) process.kill(pid);
	if (existsSync(pidPath)) rmSync(pidPath, { force: true });
	if (existsSync(jsonPath)) rmSync(jsonPath, { force: true });
	ctx.ui.notify(typeof pid === "number" ? `Trekker dashboard stopped: ${pid}` : "No Trekker dashboard metadata found.", "info");
}

async function showTrekkerDashboardStatus(ctx: ExtensionCommandContext): Promise<void> {
	const meta = readDashboardMeta(".sworm/trekker/dashboard.json");
	const healthy = meta.pid && processAlive(meta.pid) && await urlHealthy(meta.url);
	const usage = "Usage: /trekker [open|stop|status]";
	ctx.ui.notify(healthy ? `Trekker dashboard running: ${meta.url}\nPID: ${meta.pid}\nStop: /trekker stop\n${usage}` : `Trekker dashboard not running.\n${usage}`, "info");
}

export function registerTrekkerCommand(pi: ExtensionAPI): void {
	pi.registerCommand("trekker", {
		description: "Manage Trekker dashboard. Args: open, stop, status.",
		getArgumentCompletions: (prefix: string) => ["open", "stop", "status"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const command = args?.trim() || "status";
			if (command === "stop" || command === "kill") return stopTrekkerDashboard(ctx);
			if (command === "status" || command === "help") return showTrekkerDashboardStatus(ctx);
			if (command === "open") return openTrekkerDashboard(pi, ctx);
			ctx.ui.notify("Usage: /trekker [open|stop|status]", "error");
		},
	});
}
