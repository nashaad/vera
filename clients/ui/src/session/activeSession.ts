import { useSyncExternalStore } from "react";

import type { DesktopBridge } from "../protocol/bridge.ts";
import type { SessionWatch } from "./model.ts";

// The session on the page, for the title bar and the right pane, which sit outside the page.
export interface ActiveSession {
    readonly bridge: DesktopBridge;
    readonly agentId: string;
    readonly title: string;
    // For a chat this is the session's own files folder; show it as Chat, never as a path.
    readonly folder?: string;
    readonly chat: boolean;
    readonly watch: SessionWatch;
    // Writes one command line on the session's watch connection.
    readonly send: (line: string) => void;
}

let current: ActiveSession | undefined;
const listeners = new Set<() => void>();

export function publishActiveSession(session: ActiveSession): void {
    current = session;
    for (const listener of listeners) listener();
}

// Only the page that published a session may clear it, so a page leaving late cannot clear its successor.
export function clearActiveSession(agentId: string): void {
    if (current?.agentId !== agentId) return;
    current = undefined;
    for (const listener of listeners) listener();
}

export function activeSession(): ActiveSession | undefined {
    return current;
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useActiveSession(): ActiveSession | undefined {
    return useSyncExternalStore(subscribe, () => current);
}
