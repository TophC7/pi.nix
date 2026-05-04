import { createLocalBashOperations } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const FISH_PROMPT = [
	"Shell policy: bash tool is backed by fish.",
	"Use valid fish syntax only. Do not use bash-only syntax like heredocs, [[ ... ]], VAR=value command, or $?.",
	"Use `set -gx NAME value`, `$status`, `$argv`, `begin; ...; end`, and fish command substitutions.",
].join("\n");

function quoteForPosixShell(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function fishCommand(command: string): string {
	return `fish -lc ${quoteForPosixShell(command)}`;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${FISH_PROMPT}`,
	}));

	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;
		const input = event.input as { command?: unknown };
		if (typeof input.command !== "string") return;
		input.command = fishCommand(input.command);
	});

	pi.on("user_bash", () => {
		const local = createLocalBashOperations();
		return {
			operations: {
				exec(command, cwd, options) {
					return local.exec(fishCommand(command), cwd, options);
				},
			},
		};
	});
}
