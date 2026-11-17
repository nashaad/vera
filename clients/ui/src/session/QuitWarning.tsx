import { useEffect, useRef, useState } from "react";

import type { ListAgents } from "../protocol/backgroundCommands.ts";
import { watchedDesktopSessions } from "../protocol/watchedSessions.ts";
import { QuitBackgroundCommandsSheet } from "./QuitBackgroundCommandsSheet.tsx";
import { QuitWarningController, type QuitWarning as Warning } from "./quitWarning.ts";

export function QuitWarning({ listAgents }: { readonly listAgents: ListAgents }) {
    const [warning, setWarning] = useState<Warning | undefined>();
    const latestListAgents = useRef(listAgents);
    latestListAgents.current = listAgents;
    const [controller] = useState(() => new QuitWarningController({
        watchedSessions: watchedDesktopSessions,
        listAgents: (options) => latestListAgents.current(options),
        closeSession: (agentId) => window.veraDesktop.closeSession(agentId),
        showWarning: setWarning,
        closeWindow: () => window.close(),
    }));
    useEffect(() => {
        const beforeUnload = (event: BeforeUnloadEvent): void => {
            controller.beforeUnload(event, window.veraDesktop.consumeWindowClose());
        };
        window.addEventListener("beforeunload", beforeUnload);
        return () => window.removeEventListener("beforeunload", beforeUnload);
    }, [controller]);
    if (warning === undefined) return null;
    return (
        <QuitBackgroundCommandsSheet
            count={warning.count}
            onCancel={() => controller.cancel()}
            onKeepRunning={() => controller.keepRunning()}
            onStop={() => { void controller.stopAndQuit(); }}
        />
    );
}
