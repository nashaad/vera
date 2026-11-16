import { useEffect, useRef, useState } from "react";

import { freshRequestId } from "../composer/requests.ts";
import { parseCatalogLine, selectAgentCommand } from "../customize/wire.ts";
import type { DesktopBridge, SessionPane } from "../protocol/bridge.ts";
import { takePendingAgent } from "./pendingAgent.ts";

export interface StartAgent {
    // The host's reason when it refused the switch, so the session can say it stayed on its first agent.
    readonly refused: string | undefined;
    // True from the switch being sent until the host answers; a prompt sent now would go to the first agent.
    readonly starting: boolean;
}

// Switches a session that was opened for a named agent, once its watch attaches.
export function useStartAgent(
    bridge: DesktopBridge,
    agentId: string,
    attached: boolean,
    send: (line: string) => void,
    pane: SessionPane = "main",
): StartAgent {
    const [refused, setRefused] = useState<string | undefined>(undefined);
    const [starting, setStarting] = useState(false);
    const asked = useRef<string | undefined>(undefined);
    useEffect(() => {
        asked.current = undefined;
        setRefused(undefined);
        setStarting(false);
    }, [agentId]);
    useEffect(() => bridge.onEvent((event) => {
        if (event.type !== "session_frame" || event.pane !== pane || event.agentId !== agentId) return;
        const reply = parseCatalogLine(event.text);
        if (reply === undefined || reply.requestId !== asked.current) return;
        if (reply.type === "agent_rejected") setRefused(reply.reason);
        if (reply.type === "agent_rejected" || reply.type === "agent_selected") setStarting(false);
    }), [bridge, agentId, pane]);
    useEffect(() => {
        if (!attached) {
            setStarting(false);
            return;
        }
        const name = takePendingAgent(agentId);
        if (name === undefined) return;
        asked.current = freshRequestId("start-agent");
        setStarting(true);
        send(selectAgentCommand(asked.current, name));
    }, [agentId, attached, send]);
    return { refused, starting };
}
