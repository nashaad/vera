import { useCallback, useEffect, useState } from "react";

import { AgentIcon, CheckIcon } from "../components/Icons.tsx";
import { useNewChatAgents } from "../composer/newChatAgents.ts";
import type { AgentInfo } from "../customize/wire.ts";
import { useAgentCatalog } from "../customize/useAgentCatalog.ts";
import { useActiveSession } from "../session/activeSession.ts";
import { showToast } from "./toasts.ts";
import { OverlaySheet } from "./OverlaySheet.tsx";

export interface AgentSheetProps {
    readonly onClose: () => void;
}

const SCOPE_LABELS: Readonly<Record<AgentInfo["scope"], string>> = {
    project: "This folder",
    user: "Your home",
    extension: "Extension",
};

export function AgentSheet({ onClose }: AgentSheetProps) {
    const session = useActiveSession();
    const catalog = useAgentCatalog(session);
    // On New Chat there is no session; the composer offers its own list and takes the choice.
    const newChat = useNewChatAgents();
    const [picked, setPicked] = useState<string | undefined>(undefined);
    const forNewChat = session === undefined && newChat !== undefined;
    const agents = forNewChat ? newChat.agents : catalog.catalog?.agents;
    const selected = forNewChat ? newChat.selected : catalog.catalog?.selected;
    const busy = catalog.pending !== undefined;
    const pickNew = newChat?.pick;
    const { select } = catalog;

    const choose = useCallback((name: string) => {
        if (forNewChat) {
            pickNew?.(name);
            onClose();
            return;
        }
        setPicked(name);
        select(name);
    }, [forNewChat, pickNew, select, onClose]);

    useEffect(() => {
        if (agents === undefined || busy) return undefined;
        const onKey = (event: KeyboardEvent) => {
            if (event.metaKey || event.ctrlKey || event.altKey || !/^[1-9]$/.test(event.key)) return;
            const agent = agents[Number(event.key) - 1];
            if (agent === undefined) return;
            choose(agent.name);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [agents, busy, choose]);

    // The switch is confirmed once the session reports the picked agent as selected.
    useEffect(() => {
        if (picked === undefined || busy || selected !== picked) return;
        showToast(`Now running as ${picked}`, "success");
        onClose();
    }, [picked, busy, selected, onClose]);

    return (
        <OverlaySheet title="Choose Agent" Icon={AgentIcon} onClose={onClose} name="agent">
            {session === undefined && newChat === undefined ? (
                <p className="dialog-text">Open a session to choose the agent it runs as.</p>
            ) : (
                <AgentList
                    agents={agents}
                    selected={selected}
                    pending={catalog.pending}
                    error={forNewChat ? undefined : catalog.error}
                    notice={forNewChat ? undefined : catalog.notice}
                    onPick={choose}
                />
            )}
        </OverlaySheet>
    );
}

interface AgentListProps {
    readonly agents: readonly AgentInfo[] | undefined;
    readonly selected: string | undefined;
    readonly pending: string | undefined;
    readonly error: string | undefined;
    readonly notice: string | undefined;
    readonly onPick: (name: string) => void;
}

function AgentList({ agents, selected, pending, error, notice, onPick }: AgentListProps) {
    if (agents === undefined && error === undefined) {
        return <p className="dialog-text">Reading agents…</p>;
    }
    return (
        <>
            {error === undefined ? null : <p className="dialog-note" data-tone="danger" role="alert">{error}</p>}
            {notice === undefined ? null : <p className="dialog-note" data-tone="muted" role="status">{notice}</p>}
            {agents === undefined ? null : agents.length === 0 ? (
                <p className="dialog-text">This session lists no agents.</p>
            ) : (
                <ul className="dialog-picks">
                    {agents.map((agent) => {
                        const isSelected = agent.name === selected;
                        return (
                            <li key={agent.name}>
                                <button
                                    type="button"
                                    className="dialog-pick"
                                    data-agent={agent.name}
                                    data-selected={isSelected}
                                    aria-pressed={isSelected}
                                    disabled={pending !== undefined}
                                    onClick={() => onPick(agent.name)}
                                >
                                    <span className="dialog-pick-body">
                                        <span className="dialog-pick-name">
                                            {agent.name}
                                            <span className="badge">{SCOPE_LABELS[agent.scope]}</span>
                                        </span>
                                        {agent.description === undefined ? null : <span className="dialog-pick-desc">{agent.description}</span>}
                                        {agent.defaultModel === undefined ? null : (
                                            <span className="dialog-pick-meta">Default model: <code>{agent.defaultModel}</code></span>
                                        )}
                                    </span>
                                    {pending === agent.name ? <span className="dialog-pick-meta">Switching…</span> : null}
                                    {isSelected && pending !== agent.name ? <CheckIcon className="dialog-pick-check" /> : null}
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </>
    );
}
