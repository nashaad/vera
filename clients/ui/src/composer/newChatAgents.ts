import { useSyncExternalStore } from "react";

import type { AgentInfo } from "../customize/wire.ts";

// The agents New Chat offers, for the Choose Agent sheet and /agent, which sit outside the composer.
export interface NewChatAgents {
    readonly agents: readonly AgentInfo[];
    // The agent the new session will start on.
    readonly selected: string;
    readonly pick: (name: string) => void;
}

let current: NewChatAgents | undefined;
const listeners = new Set<() => void>();

function notify(): void {
    for (const listener of listeners) listener();
}

// Returns a function that withdraws this entry; one that a later entry replaced is left alone.
export function publishNewChatAgents(entry: NewChatAgents): () => void {
    current = entry;
    notify();
    return () => {
        if (current !== entry) return;
        current = undefined;
        notify();
    };
}

export function currentNewChatAgents(): NewChatAgents | undefined {
    return current;
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useNewChatAgents(): NewChatAgents | undefined {
    return useSyncExternalStore(subscribe, () => current);
}
