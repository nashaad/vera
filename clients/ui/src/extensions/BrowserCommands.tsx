import { useState, useSyncExternalStore } from "react";

import { PointerIcon } from "../components/PointerIcon.tsx";
import { queuePageCapture } from "../composer/page-captures.ts";
import { useActiveSession } from "../session/activeSession.ts";
import { desktopExtensions, subscribeDesktopExtensions } from "./state.ts";

interface BrowserCommandsProps {
    readonly hasPage: boolean;
    readonly onError: (reason: string | undefined) => void;
}

export function BrowserCommands({ hasPage, onError }: BrowserCommandsProps) {
    const extensions = useSyncExternalStore(subscribeDesktopExtensions, desktopExtensions);
    const session = useActiveSession();
    const [running, setRunning] = useState(false);
    const run = async (command: string): Promise<void> => {
        const owner = session?.agentId;
        if (owner === undefined || window.veraDesktop === undefined) return;
        setRunning(true);
        onError(undefined);
        try {
            const result = await window.veraDesktop.runExtensionCommand(command, undefined, (progress) => {
                if (!progress.ok) onError(progress.reason);
                else if (progress.kind === "capture") {
                    onError(undefined);
                    queuePageCapture(owner, progress.capture);
                }
            });
            if (!result.ok) onError(result.reason);
            else if (result.kind === "capture") queuePageCapture(owner, result.capture);
        } catch { onError("The page could not be read."); }
        finally { setRunning(false); }
    };
    return extensions?.filter((entry) => entry.enabled).flatMap((entry) => entry.menus.browser ?? []).map((item) => (
        <button key={item.command} type="button" className="icon-button" aria-label={item.title} title={item.title} aria-pressed={running} disabled={!hasPage || session === undefined || running} onClick={() => void run(item.command)}>
            {item.icon === "pointer" ? <PointerIcon /> : null}
        </button>
    ));
}
