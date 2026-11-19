import { useEffect, useRef } from "react";

import { registerChatCommands } from "../commands/chat-commands.ts";
import type { CommandRegistry } from "../commands/registry.ts";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { useWorkbench } from "../workbench/context.tsx";
import { startHelpChat } from "./help.ts";

// Registers the commands that open a chat in a Chat tab.
export function ChatCommands({ commands }: { readonly commands: CommandRegistry }) {
    const workbench = useWorkbench();
    const latest = useRef(workbench);
    latest.current = workbench;

    useEffect(() => registerChatCommands(commands, {
        help: () => {
            const bridge = window.veraDesktop as DesktopBridge | undefined;
            if (bridge !== undefined) void startHelpChat(bridge, () => latest.current);
        },
    }), [commands]);
    return null;
}
