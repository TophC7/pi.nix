import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, normalize, relative, resolve, sep } from "node:path";
import type { SaveResult } from "./types.ts";

function assertInside(root: string, filePath: string): string {
	const fullRoot = resolve(root);
	const fullPath = resolve(filePath);
	const rel = relative(fullRoot, fullPath);
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
		throw new Error(`Path outside allowed root: ${filePath}`);
	}
	return fullPath;
}

function requireMetadata(content: string): void {
	const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);
	if (!frontmatter) throw new Error("Missing YAML frontmatter.");
	const metadata = frontmatter[1] ?? "";
	const hasAskClaude = /hardened_by:\s*AskClaude/.test(metadata) && /hardened_status:\s*passed/.test(metadata);
	const hasWaiver = /hardened_by:\s*waiver/.test(metadata) && /hardened_status:\s*waived/.test(metadata) && /waiver_reason:\s*\S/.test(metadata);
	if (!hasAskClaude && !hasWaiver) {
		throw new Error("Missing AskClaude hardening metadata or explicit waiver.");
	}
}

export function saveFile(root: string, path: string, content: string, metadataRequired = true): SaveResult {
	const normalized = normalize(path);
	const fullPath = assertInside(root, normalized);
	if (metadataRequired) requireMetadata(content);
	mkdirSync(dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, content);
	return { path: relative(process.cwd(), fullPath), bytes: Buffer.byteLength(content) };
}

export function readFrontmatterValue(content: string, key: string): string {
	const match = content.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
	return match?.[1]?.trim() ?? "";
}

