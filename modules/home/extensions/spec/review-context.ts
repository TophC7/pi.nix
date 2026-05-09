import { statSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { captureProcessBounded, readFileBounded } from "./bounded-capture.ts";
import { resolveInside } from "./paths.ts";
import { formatReviewTarget, type ReviewTarget } from "./review-targets.ts";

export const REVIEW_CONTEXT_PER_FILE_LIMIT = 200 * 1024;
export const REVIEW_CONTEXT_TOTAL_LIMIT = 2 * 1024 * 1024;

export interface ReviewContextCapture {
	target: ReviewTarget;
	content: string;
	bytes: number;
	truncated: boolean;
	notes: string[];
}

interface NameStatusEntry {
	status: string;
	path: string;
	oldPath?: string;
}

interface ContextBuilder {
	add(title: string, body: string, options?: { fileScoped?: boolean }): void;
	remainingBytes(): number;
	isFull(): boolean;
	recordTruncation(note: string): void;
	omit(title: string, count?: number): void;
	finish(): ReviewContextCapture;
}

export async function captureReviewContext(pi: ExtensionAPI, ctx: ExtensionCommandContext, target: ReviewTarget): Promise<ReviewContextCapture> {
	const builder = createContextBuilder(target);
	builder.add("Target", formatReviewTarget(target));

	switch (target.kind) {
		case "working-tree":
			await captureWorkingTree(pi, ctx, builder);
			break;
		case "staged":
			await captureStaged(pi, ctx, builder);
			break;
		case "range":
			await captureRange(pi, ctx, builder, target.base, target.head);
			break;
		case "branch":
			await captureRange(pi, ctx, builder, target.base ?? "HEAD", target.name, target.base ? "branch range" : "branch vs HEAD");
			break;
		case "paths":
			capturePaths(ctx, builder, target.paths);
			break;
		case "paste":
			builder.add("Pasted context", target.content, { fileScoped: true });
			break;
		case "freeform":
			capturePaths(ctx, builder, [target.path]);
			break;
	}

	return builder.finish();
}

async function captureWorkingTree(pi: ExtensionAPI, ctx: ExtensionCommandContext, builder: ContextBuilder): Promise<void> {
	await requireGitRepo(pi, ctx);
	builder.add("git status --short", await execText(pi, ctx, ["status", "--short"]));
	await captureNamedDiff(pi, ctx, builder, ["diff", "--cached", "--find-renames"], ["diff", "--cached", "--name-status", "-z"], "Staged changes");
	await captureNamedDiff(pi, ctx, builder, ["diff", "--find-renames"], ["diff", "--name-status", "-z"], "Unstaged changes");
	const untracked = splitZ(await execText(pi, ctx, ["ls-files", "--others", "--exclude-standard", "-z"]));
	if (untracked.length === 0) {
		builder.add("Untracked files", "<none>");
		return;
	}
	capturePaths(ctx, builder, untracked, "Untracked file");
}

async function captureStaged(pi: ExtensionAPI, ctx: ExtensionCommandContext, builder: ContextBuilder): Promise<void> {
	await requireGitRepo(pi, ctx);
	await captureNamedDiff(pi, ctx, builder, ["diff", "--cached", "--find-renames"], ["diff", "--cached", "--name-status", "-z"], "Staged changes");
}

async function captureRange(pi: ExtensionAPI, ctx: ExtensionCommandContext, builder: ContextBuilder, base: string, head: string, label = "Range changes"): Promise<void> {
	await requireGitRepo(pi, ctx);
	await captureNamedDiff(pi, ctx, builder, ["diff", "--find-renames", base, head], ["diff", "--name-status", "-z", base, head], `${label}: ${base}..${head}`);
}

async function captureNamedDiff(pi: ExtensionAPI, ctx: ExtensionCommandContext, builder: ContextBuilder, diffArgs: string[], nameArgs: string[], title: string): Promise<void> {
	const entries = parseNameStatusZ(await execText(pi, ctx, nameArgs));
	if (entries.length === 0) {
		builder.add(title, "<none>");
		return;
	}
	let omitted = 0;
	for (const entry of entries) {
		const location = entry.oldPath ? `${entry.oldPath} -> ${entry.path}` : entry.path;
		if (builder.isFull()) {
			omitted++;
			continue;
		}
		if (entry.status.startsWith("D")) {
			builder.add(`${title}: ${entry.status} ${location}`, "Deleted file; content omitted.", { fileScoped: true });
			continue;
		}
		const diff = await execGitTextBounded(ctx, [...diffArgs, "--", entry.path], Math.min(REVIEW_CONTEXT_PER_FILE_LIMIT, builder.remainingBytes()));
		builder.add(`${title}: ${entry.status} ${location}`, diff.text || "<metadata-only change>", { fileScoped: true });
		if (diff.note) builder.recordTruncation(diff.note);
	}
	if (omitted > 0) builder.omit(title, omitted);
}

function capturePaths(ctx: ExtensionCommandContext, builder: ContextBuilder, paths: string[], title = "File context"): void {
	let omitted = 0;
	for (const path of paths) {
		if (builder.isFull()) {
			omitted++;
			continue;
		}
		capturePath(ctx, builder, path, title);
	}
	if (omitted > 0) builder.omit(title, omitted);
}

function capturePath(ctx: ExtensionCommandContext, builder: ContextBuilder, path: string, title: string): void {
	const fullPath = resolveInside(ctx.cwd, path);
	const stat = statSync(fullPath);
	if (!stat.isFile()) {
		builder.add(`${title}: ${path}`, `Not a regular file (${stat.isDirectory() ? "directory" : "special file"}); content omitted.`, { fileScoped: true });
		return;
	}
	const maxBytes = Math.min(REVIEW_CONTEXT_PER_FILE_LIMIT, builder.remainingBytes());
	if (maxBytes <= 0) {
		builder.omit(title);
		return;
	}
	const data = readFileBounded(fullPath, maxBytes);
	if (isBinary(data.content)) {
		builder.add(`${title}: ${path}`, `Binary file summarized only (${data.totalBytes} bytes, sampled ${data.bytesRead} bytes).`, { fileScoped: true });
		return;
	}
	const text = data.content.toString("utf8");
	if (data.truncated) {
		const note = `\n\n[truncated: file read exceeded ${data.bytesRead} of ${data.totalBytes} bytes]`;
		const bodyLimit = Math.max(0, REVIEW_CONTEXT_PER_FILE_LIMIT - Buffer.byteLength(note, "utf8"));
		builder.add(`${title}: ${path}`, `${takeUtf8(text, bodyLimit)}${note}`, { fileScoped: true });
		builder.recordTruncation(`${title}: ${path} truncated at ${data.bytesRead} of ${data.totalBytes} bytes.`);
		return;
	}
	builder.add(`${title}: ${path}`, text, { fileScoped: true });
}

function createContextBuilder(target: ReviewTarget): ContextBuilder {
	const notes: string[] = [];
	let content = `# /plan:review context\n\n`;
	let bytes = Buffer.byteLength(content, "utf8");
	let truncated = false;

	return {
		add(title, body, options) {
			let renderedBody = body || "<empty>";
			const bodyBytes = Buffer.byteLength(renderedBody, "utf8");
			if (options?.fileScoped && bodyBytes > REVIEW_CONTEXT_PER_FILE_LIMIT) {
				renderedBody = `${takeUtf8(renderedBody, REVIEW_CONTEXT_PER_FILE_LIMIT)}\n\n[truncated: file context exceeded ${REVIEW_CONTEXT_PER_FILE_LIMIT} bytes]`;
				notes.push(`${title} truncated at ${REVIEW_CONTEXT_PER_FILE_LIMIT} bytes.`);
				truncated = true;
			}
			const section = `## ${title}\n\n\`\`\`\n${renderedBody}\n\`\`\`\n\n`;
			const sectionBytes = Buffer.byteLength(section, "utf8");
			const remaining = REVIEW_CONTEXT_TOTAL_LIMIT - bytes;
			if (remaining <= 0) {
				truncated = true;
				return;
			}
			if (sectionBytes > remaining) {
				content += `${takeUtf8(section, remaining)}\n\n[truncated: total review context exceeded ${REVIEW_CONTEXT_TOTAL_LIMIT} bytes]\n`;
				notes.push(`Total context truncated at ${REVIEW_CONTEXT_TOTAL_LIMIT} bytes.`);
				bytes = Buffer.byteLength(content, "utf8");
				truncated = true;
				return;
			}
			content += section;
			bytes += sectionBytes;
		},
		remainingBytes() {
			return Math.max(0, REVIEW_CONTEXT_TOTAL_LIMIT - bytes);
		},
		isFull() {
			return bytes >= REVIEW_CONTEXT_TOTAL_LIMIT;
		},
		recordTruncation(note) {
			notes.push(note);
			truncated = true;
		},
		omit(title, count = 1) {
			const suffix = count === 1 ? "entry" : "entries";
			notes.push(`${title}: omitted ${count} ${suffix} after context cap filled.`);
			truncated = true;
		},
		finish() {
			return { target, content, bytes, truncated, notes };
		},
	};
}

async function requireGitRepo(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const result = await pi.exec("git", ["rev-parse", "--git-dir"], { cwd: ctx.cwd, signal: ctx.signal });
	if ((result.code ?? 1) !== 0) throw new Error("/plan:review target requires a git repository.");
}

async function execText(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string[]): Promise<string> {
	const result = await pi.exec("git", args, { cwd: ctx.cwd, signal: ctx.signal, timeout: 120000 });
	if ((result.code ?? 1) !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`.trim());
	return result.stdout ?? "";
}

async function execGitTextBounded(ctx: ExtensionCommandContext, args: string[], maxBytes: number): Promise<{ text: string; note?: string }> {
	if (maxBytes <= 0) return { text: "" };
	const result = await captureProcessBounded("git", args, {
		cwd: ctx.cwd,
		signal: ctx.signal,
		timeoutMs: 120000,
		maxStdoutBytes: maxBytes,
	});
	if ((result.code ?? 1) !== 0 && !result.truncated) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`.trim());
	if (!result.truncated) return { text: result.stdout };
	const note = `\n\n[truncated: git output exceeded ${Math.min(maxBytes, result.stdout.length)} captured bytes; process stopped after ${result.stdoutBytes} stdout bytes]`;
	const bodyLimit = Math.max(0, maxBytes - Buffer.byteLength(note, "utf8"));
	return { text: `${takeUtf8(result.stdout, bodyLimit)}${note}`, note: `git ${args.join(" ")} truncated after ${result.stdoutBytes} stdout bytes.` };
}

function parseNameStatusZ(raw: string): NameStatusEntry[] {
	const parts = splitZ(raw);
	const entries: NameStatusEntry[] = [];
	for (let index = 0; index < parts.length;) {
		const status = parts[index++];
		if (!status) break;
		if (status.startsWith("R") || status.startsWith("C")) {
			const oldPath = parts[index++];
			const path = parts[index++];
			if (oldPath && path) entries.push({ status, oldPath, path });
			continue;
		}
		const path = parts[index++];
		if (path) entries.push({ status, path });
	}
	return entries;
}

function splitZ(raw: string): string[] {
	return raw.split("\0").filter(Boolean);
}

function isBinary(data: Buffer): boolean {
	if (data.includes(0)) return true;
	const sample = data.subarray(0, Math.min(data.length, 4096)).toString("utf8");
	return sample.includes("�");
}

function takeUtf8(text: string, maxBytes: number): string {
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += char.length;
	}
	return text.slice(0, end);
}
