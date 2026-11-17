import { useEffect, useRef, useState } from "react";

import { useRouter } from "../pages/router.tsx";
import { sessionPlace, type SessionRoute } from "../pages/routes.ts";
import { backgroundCommandCount } from "../protocol/backgroundCommands.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { CloseBackgroundCommandsSheet, type BackgroundCommandWarning } from "../session/CloseBackgroundCommandsSheet.tsx";
import type { CommandRegistry } from "./registry.ts";
import { registerSessionWindowCommands } from "./session-window-commands.ts";

// Registers the session commands that need the router and the session list.
export function SessionWindowCommands({ commands }: { readonly commands: CommandRegistry }) {
    const { navigate } = useRouter();
    const { connection, listAgents } = useViewEnvironment();
    const navigation = useRef(navigate);
    const rows = useRef(connection.sessionRows);
    const listAgentsRef = useRef(listAgents);
    const [warning, setWarning] = useState<BackgroundCommandWarning | undefined>();
    navigation.current = navigate;
    rows.current = connection.sessionRows;
    listAgentsRef.current = listAgents;

    useEffect(() => registerSessionWindowCommands(commands, {
        navigate: (route) => navigation.current(route),
        parentRoute: (agentId): SessionRoute | undefined => {
            const list = rows.current ?? [];
            const parentId = list.find((row) => row.id === agentId)?.parentId;
            const parent = parentId === undefined ? undefined : list.find((row) => row.id === parentId);
            if (parent === undefined) return undefined;
            return { kind: "session", agentId: parent.id, title: parent.name, ...sessionPlace(parent.workspace, parent.chat) };
        },
        bridge: () => window.veraDesktop,
        backgroundCommandCount: (agentId) => backgroundCommandCount(listAgentsRef.current, agentId),
        warnAboutBackgroundCommands: (target, count, confirm) => setWarning({ target, count, confirm }),
    }), [commands]);
    if (warning === undefined) return null;
    return (
        <CloseBackgroundCommandsSheet
            warning={warning}
            onCancel={() => setWarning(undefined)}
            onConfirm={() => {
                const current = warning;
                setWarning(undefined);
                current.confirm();
            }}
        />
    );
}
