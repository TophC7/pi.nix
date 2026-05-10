import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type DefinedCommand, normalizeCommandName } from "./command.ts";

export interface DefineExtensionOptions {
	readonly name: string;
	readonly commands?: readonly DefinedCommand[];
	readonly setup?: (pi: ExtensionAPI) => Promise<void> | void;
}

export type DefinedExtension = (pi: ExtensionAPI) => Promise<void> | void;

export function defineExtension(options: DefineExtensionOptions): DefinedExtension {
	return async (pi: ExtensionAPI) => {
		await options.setup?.(pi);
		for (const command of options.commands ?? []) {
			const { name, workflow: _workflow, handoff: _handoff, ...registration } = command;
			pi.registerCommand(normalizeCommandName(name), registration);
		}
	};
}
