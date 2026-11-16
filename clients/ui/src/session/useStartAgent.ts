import { useEffect, useRef, useState } from "react";

import { freshRequestId } from "../composer/requests.ts";
import { parseCatalogLine, selectAgentCommand } from "../customize/wire.ts";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { NO_AGENT_START, startAfterReply, type AgentStart } from "./agentGate.ts";
import { takePendingAgent } from "./pendingAgent.ts";

// Switches a session that was opened for a named agent, once its watch attaches. Reports the host's
// answer, so the session can say it stayed on its first agent and a held prompt knows when to go.
export function useStartAgent(
    bridge: DesktopBridge,
    agentId: string,
    attached: boolean,
    send: (line: string) => void,
): AgentStart {
    const [start, setStart] = useState<AgentStart>(NO_AGENT_START);
    const asked = useRef<string | undefined>(undefined);
    useEffect(() => {
        asked.current = undefined;
        setStart(NO_AGENT_START);
    }, [agentId]);
    useEffect(() => bridge.onEvent((event) => {
        if (event.type !== "session_frame" || event.pane !== "main" || event.agentId !== agentId) return;
        const reply = parseCatalogLine(event.text);
        if (reply === undefined) return;
        const requestId = asked.current;
        setStart((current) => startAfterReply(current, reply, requestId));
    }), [bridge, agentId]);
    useEffect(() => {
        if (!attached) return;
        const name = takePendingAgent(agentId);
        if (name === undefined) return;
        asked.current = freshRequestId("start-agent");
        setStart({ name, selected: false });
        send(selectAgentCommand(asked.current, name));
    }, [agentId, attached, send]);
    return start;
}
