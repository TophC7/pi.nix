import { defineExtension } from "@pi/lib";
import { registerCleanupCommands } from "./commands.ts";

export default defineExtension({
	name: "cleanup",
	setup: registerCleanupCommands,
});
