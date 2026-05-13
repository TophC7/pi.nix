import { createLocalBashOperations } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const ORIGINAL_BASH_COMMAND_KEY = "__piOriginalCommand";

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

// use-fish is declared as a Pi package (rank 4) so its tool_call handler runs
// after extension-rank handlers and after other packages listed before it in
// settings.packages. That ordering lets rtk-optimizer rewrite raw bash commands
// before we wrap them in `fish -lc '...'`. If use-fish ran first, RTK would see
// a fish wrapper as the leading token and silently skip every rewrite.
export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${FISH_PROMPT}`,
	}));

	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;
		const input = event.input as { command?: unknown; [ORIGINAL_BASH_COMMAND_KEY]?: unknown };
		if (typeof input.command !== "string") return;
		if (typeof input[ORIGINAL_BASH_COMMAND_KEY] !== "string") input[ORIGINAL_BASH_COMMAND_KEY] = input.command;
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
