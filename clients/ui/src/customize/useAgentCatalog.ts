import { useCallback, useEffect, useState } from "react";

import { freshRequestId } from "../composer/requests.ts";
import type { ActiveSession } from "../session/activeSession.ts";
import { listAgentsCommand, parseCatalogLine, selectAgentCommand, type AgentCatalogReply } from "./wire.ts";

const CATALOG_TIMEOUT_MS = 10_000;

export interface AgentCatalogState {
    readonly catalog?: AgentCatalogReply;
    // Set when the catalog did not arrive or a choice was refused; phrased for the person.
    readonly error?: string;
    // The agent asked for and not yet confirmed.
    readonly pending?: string;
    // The session's answer to the last choice, when it had something to say.
    readonly notice?: string;
    readonly select: (name: string) => void;
}

// Reads the open session's agents through its own watch connection and switches between them.
export function useAgentCatalog(session: ActiveSession | undefined): AgentCatalogState {
    const [catalog, setCatalog] = useState<AgentCatalogReply | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const [pending, setPending] = useState<{ readonly requestId: string; readonly name: string } | undefined>(undefined);
    const [notice, setNotice] = useState<string | undefined>(undefined);
    const bridge = session?.bridge;
    const agentId = session?.agentId;
    const send = session?.send;
    const attached = session?.watch.phase === "attached";

    useEffect(() => {
        if (bridge === undefined || agentId === undefined || send === undefined || !attached) return undefined;
        const requestId = freshRequestId("agents");
        setCatalog(undefined);
        setError(undefined);
        const timer = setTimeout(() => setError("The session did not list its agents in time."), CATALOG_TIMEOUT_MS);
        const off = bridge.onEvent((event) => {
            if (event.type !== "session_frame" || event.pane !== "main" || event.agentId !== agentId) return;
            const reply = parseCatalogLine(event.text);
            if (reply?.type !== "agents" || reply.requestId !== requestId) return;
            clearTimeout(timer);
            setCatalog(reply);
        });
        send(listAgentsCommand(requestId));
        return () => {
            clearTimeout(timer);
            off();
        };
    }, [bridge, agentId, send, attached]);

    useEffect(() => {
        if (bridge === undefined || agentId === undefined || pending === undefined) return undefined;
        return bridge.onEvent((event) => {
            if (event.type !== "session_frame" || event.pane !== "main" || event.agentId !== agentId) return;
            const reply = parseCatalogLine(event.text);
            if (reply === undefined || reply.requestId !== pending.requestId) return;
            if (reply.type === "agent_selected") {
                setCatalog((current) => current === undefined ? current : { ...current, selected: reply.name });
                setNotice(reply.notice);
                setPending(undefined);
            } else if (reply.type === "agent_rejected") {
                setError(reply.reason);
                setPending(undefined);
            }
        });
    }, [bridge, agentId, pending]);

    const select = useCallback((name: string) => {
        if (send === undefined) return;
        const requestId = freshRequestId("select-agent");
        setError(undefined);
        setNotice(undefined);
        setPending({ requestId, name });
        send(selectAgentCommand(requestId, name));
    }, [send]);

    return {
        select,
        ...(catalog === undefined ? {} : { catalog }),
        ...(error === undefined ? {} : { error }),
        ...(pending === undefined ? {} : { pending: pending.name }),
        ...(notice === undefined ? {} : { notice }),
    };
}
