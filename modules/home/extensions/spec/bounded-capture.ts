import { spawn } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export interface BoundedReadResult {
	content: Buffer;
	bytesRead: number;
	totalBytes: number;
	truncated: boolean;
}

export interface BoundedProcessResult {
	stdout: string;
	stderr: string;
	stdoutBytes: number;
	stderrBytes: number;
	code: number | null;
	signal: NodeJS.Signals | null;
	truncated: boolean;
	timedOut: boolean;
}

export interface BoundedProcessOptions {
	cwd?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxStdoutBytes: number;
	maxStderrBytes?: number;
}

export function readFileBounded(path: string, maxBytes: number): BoundedReadResult {
	if (maxBytes < 0) throw new Error("maxBytes must be non-negative.");
	const fd = openSync(path, "r");
	try {
		const stat = fstatSync(fd);
		const limit = Math.min(maxBytes, stat.size);
		const content = Buffer.alloc(limit);
		const bytesRead = limit === 0 ? 0 : readSync(fd, content, 0, limit, 0);
		return { content: content.subarray(0, bytesRead), bytesRead, totalBytes: stat.size, truncated: stat.size > bytesRead };
	} finally {
		closeSync(fd);
	}
}

export function captureProcessBounded(command: string, args: string[], options: BoundedProcessOptions): Promise<BoundedProcessResult> {
	const maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { cwd: options.cwd, signal: options.signal, stdio: ["ignore", "pipe", "pipe"] });
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let truncated = false;
		let timedOut = false;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;

		function killForTruncation(): void {
			if (!child.killed) child.kill("SIGTERM");
		}

		function captureChunk(chunks: Buffer[], chunk: Buffer, currentBytes: number, maxBytes: number): number {
			if (currentBytes >= maxBytes) {
				truncated = true;
				return currentBytes + chunk.length;
			}
			const remaining = maxBytes - currentBytes;
			if (chunk.length > remaining) {
				chunks.push(chunk.subarray(0, remaining));
				truncated = true;
				return currentBytes + chunk.length;
			}
			chunks.push(chunk);
			return currentBytes + chunk.length;
		}

		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutBytes = captureChunk(stdoutChunks, chunk, stdoutBytes, options.maxStdoutBytes);
			if (truncated) killForTruncation();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrBytes = captureChunk(stderrChunks, chunk, stderrBytes, maxStderrBytes);
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			resolvePromise({
				stdout: Buffer.concat(stdoutChunks).toString("utf8"),
				stderr: Buffer.concat(stderrChunks).toString("utf8"),
				stdoutBytes,
				stderrBytes,
				code,
				signal,
				truncated,
				timedOut,
			});
		});
		if (options.timeoutMs) {
			timeout = setTimeout(() => {
				timedOut = true;
				if (!child.killed) child.kill("SIGTERM");
			}, options.timeoutMs);
		}
	});
}
