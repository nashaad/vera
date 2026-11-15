import { useEffect, useRef, useState } from "react";

import { freshRequestId } from "../composer/requests.ts";
import { parseCatalogLine, selectAgentCommand } from "../customize/wire.ts";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { takePendingAgent } from "./pendingAgent.ts";

// Switches a session that was opened for a named agent, once its watch attaches. Returns the host's
// reason when it refuses, so the session can say it stayed on its first agent.
export function useStartAgent(
    bridge: DesktopBridge,
    agentId: string,
    attached: boolean,
    send: (line: string) => void,
): string | undefined {
    const [refused, setRefused] = useState<string | undefined>(undefined);
    const asked = useRef<string | undefined>(undefined);
    useEffect(() => {
        asked.current = undefined;
        setRefused(undefined);
    }, [agentId]);
    useEffect(() => bridge.onEvent((event) => {
        if (event.type !== "session_frame" || event.pane !== "main" || event.agentId !== agentId) return;
        const reply = parseCatalogLine(event.text);
        if (reply?.type === "agent_rejected" && reply.requestId === asked.current) setRefused(reply.reason);
    }), [bridge, agentId]);
    useEffect(() => {
        if (!attached) return;
        const name = takePendingAgent(agentId);
        if (name === undefined) return;
        asked.current = freshRequestId("start-agent");
        send(selectAgentCommand(asked.current, name));
    }, [agentId, attached, send]);
    return refused;
}
