import { useEffect, useRef } from "react";

import { useRouter } from "../pages/router.tsx";
import { sessionPlace, type SessionRoute } from "../pages/routes.ts";
import { useViewEnvironment } from "../views/env.tsx";
import type { CommandRegistry } from "./registry.ts";
import { registerSessionWindowCommands } from "./session-window-commands.ts";

// Registers the session commands that need the router and the session list.
export function SessionWindowCommands({ commands }: { readonly commands: CommandRegistry }) {
    const { navigate } = useRouter();
    const { connection } = useViewEnvironment();
    const navigation = useRef(navigate);
    const rows = useRef(connection.sessionRows);
    navigation.current = navigate;
    rows.current = connection.sessionRows;

    useEffect(() => registerSessionWindowCommands(commands, {
        navigate: (route) => navigation.current(route),
        parentRoute: (agentId): SessionRoute | undefined => {
            const list = rows.current ?? [];
            const parentId = list.find((row) => row.id === agentId)?.parentId;
            const parent = parentId === undefined ? undefined : list.find((row) => row.id === parentId);
            if (parent === undefined) return undefined;
            return { kind: "session", agentId: parent.id, title: parent.name, ...sessionPlace(parent.workspace, parent.chat) };
        },
    }), [commands]);
    return null;
}
