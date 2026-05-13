import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface SettingsFile {
	skills?: unknown;
	[key: string]: unknown;
}

export interface SkillToggleState {
	readonly disabled: boolean;
	readonly settingsPath: string;
	readonly toggleable: boolean;
	readonly error?: string;
}

export function getAgentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (!env) return path.join(os.homedir(), ".pi", "agent");
	if (env === "~") return os.homedir();
	if (env.startsWith("~/")) return path.join(os.homedir(), env.slice(2));
	return env;
}

function settingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
}

function readSettings(filePath = settingsPath()): SettingsFile {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		const code = typeof error === "object" && error && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") return {};
		throw error;
	}
	try {
		return JSON.parse(text) as SettingsFile;
	} catch (error) {
		throw new Error(`Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function writeSettings(settings: SettingsFile, filePath = settingsPath()): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function resolveSettingPath(entry: string, baseDir: string): string {
	const value = entry.trim();
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	if (path.isAbsolute(value)) return path.normalize(value);
	return path.resolve(baseDir, value);
}

function disableEntryForSkill(skillPath: string, agentDir = getAgentDir()): string {
	const skillDir = path.dirname(skillPath);
	if (skillDir.startsWith(`${agentDir}${path.sep}`)) return `-${path.relative(agentDir, skillDir)}`;
	return `-${skillDir}`;
}

function disabledEntryMatches(entry: string, skillPath: string, settingsDir: string): boolean {
	if (!entry.startsWith("-")) return false;
	const target = resolveSettingPath(entry.slice(1), settingsDir);
	const normalizedSkill = path.normalize(skillPath);
	return target === normalizedSkill || target === path.dirname(normalizedSkill);
}

export function getSkillToggleState(skillPath: string): SkillToggleState {
	const filePath = settingsPath();
	const settings = readSettings(filePath);
	const settingsDir = path.dirname(filePath);
	const skills = readSkillEntries(settings);
	if (!skills.ok) return { disabled: false, settingsPath: filePath, toggleable: false, error: skills.error };
	const disabled = skills.entries.some((entry) => typeof entry === "string" && disabledEntryMatches(entry, skillPath, settingsDir));
	return { disabled, settingsPath: filePath, toggleable: true };
}

export function toggleSkillDisabled(skillPath: string): SkillToggleState {
	const filePath = settingsPath();
	const settings = readSettings(filePath);
	const settingsDir = path.dirname(filePath);
	const skills = readSkillEntries(settings);
	if (!skills.ok) throw new Error(skills.error);
	const disabled = skills.entries.some((entry) => typeof entry === "string" && disabledEntryMatches(entry, skillPath, settingsDir));
	settings.skills = disabled
		? skills.entries.filter((entry) => !(typeof entry === "string" && disabledEntryMatches(entry, skillPath, settingsDir)))
		: [...skills.entries, disableEntryForSkill(skillPath)];
	writeSettings(settings, filePath);
	return { disabled: !disabled, settingsPath: filePath, toggleable: true };
}

function readSkillEntries(settings: SettingsFile): { ok: true; entries: readonly unknown[] } | { ok: false; error: string } {
	if (settings.skills === undefined) return { ok: true, entries: [] };
	if (Array.isArray(settings.skills)) return { ok: true, entries: settings.skills };
	return { ok: false, error: "settings.skills must be an array before skills can be toggled." };
}
