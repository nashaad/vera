import type { CommandRegistry } from "./registry.ts";
import { SESSION_COMMANDS } from "./session-commands.ts";

export interface SubagentCommandTarget {
    // Shows the Subagents tab on the open session's list; does nothing while no session is open.
    readonly show: () => void;
}

export function registerSubagentCommands(registry: CommandRegistry, target: SubagentCommandTarget): () => void {
    return registry.register({ id: SESSION_COMMANDS.subagents, title: "Show Subagents", run: () => target.show() });
}
