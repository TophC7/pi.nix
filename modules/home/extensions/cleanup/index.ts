import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerCleanupCommands } from "./commands.ts";

export default function cleanupExtension(pi: ExtensionAPI) {
	registerCleanupCommands(pi);
}
