import { useEffect, useRef } from "react";

import { browserHistory } from "../browser/store.ts";
import { CORE_CONTAINERS } from "../registry/core.ts";
import { useWorkbench } from "../workbench/context.tsx";
import { revealContainer } from "../workbench/reveal.ts";
import { registerPageCommands } from "./page-commands.ts";
import type { CommandRegistry } from "./registry.ts";

// Registers the commands that open one of Vera's pages in the right pane browser.
export function PageCommands({ commands }: { readonly commands: CommandRegistry }) {
    const workbench = useWorkbench();
    const latest = useRef(workbench);
    latest.current = workbench;

    useEffect(() => registerPageCommands(commands, {
        open: (entry) => {
            browserHistory.browse(entry);
            revealContainer(latest.current, CORE_CONTAINERS.browser);
        },
    }), [commands]);
    return null;
}
