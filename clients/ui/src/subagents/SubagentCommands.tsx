import { useEffect, useRef } from "react";

import { registerSubagentCommands } from "../commands/subagent-commands.ts";
import type { CommandRegistry } from "../commands/registry.ts";
import { activeSession } from "../session/activeSession.ts";
import { useWorkbench } from "../workbench/context.tsx";
import { openSubagents } from "./open.ts";

// Registers the command that opens the Subagents tab, which needs the workbench.
export function SubagentCommands({ commands }: { readonly commands: CommandRegistry }) {
    const workbench = useWorkbench();
    const latest = useRef(workbench);
    latest.current = workbench;

    useEffect(() => registerSubagentCommands(commands, {
        show: () => {
            const session = activeSession();
            if (session !== undefined) openSubagents(latest.current, session.agentId);
        },
    }), [commands]);
    return null;
}
