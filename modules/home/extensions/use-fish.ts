import { Type } from "typebox";
import {
	truncateTail,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
} from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "bash", // We override the built-in tool by using the exact same name
		label: "Fish Shell",
		description:
			"Execute a fish shell command in the current working directory. Returns stdout and stderr. You MUST use valid fish syntax, NOT bash syntax.",
		parameters: Type.Object({
			command: Type.String({ description: "Fish command to execute" }),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in seconds" }),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const timeoutMs = params.timeout ? params.timeout * 1000 : undefined;

			const result = await pi.exec("fish", ["-c", params.command], {
				signal,
				timeout: timeoutMs,
			});

			let rawOutput = "";
			if (result.stdout) rawOutput += result.stdout;
			if (result.stderr) rawOutput += (rawOutput ? "\n" : "") + result.stderr;
			if (!rawOutput) rawOutput = "(No output)";
			if (result.code !== 0) rawOutput += `\n(Exit code: ${result.code})`;

			const truncation = truncateTail(rawOutput, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let finalOutput = truncation.content;
			if (truncation.truncated) {
				finalOutput += `\n\n[Output truncated: kept last ${truncation.outputLines} lines]`;
			}

			return {
				content: [{ type: "text", text: finalOutput }],
				details: {
					...result,
					stdout: finalOutput,
					stderr: "",
					truncated: truncation.truncated,
				},
			};
		},
	});
}
