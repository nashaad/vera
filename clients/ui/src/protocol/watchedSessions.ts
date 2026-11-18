import type { DesktopBridge, SessionPane } from "./bridge.ts";

const watched = new Map<SessionPane, string>();

export function watchDesktopSession(bridge: DesktopBridge, pane: SessionPane, agentId: string): void {
    watched.set(pane, agentId);
    bridge.watchSession(pane, agentId);
}

export function unwatchDesktopSession(bridge: DesktopBridge, pane: SessionPane): void {
    watched.delete(pane);
    bridge.unwatchSession(pane);
}

export function watchedDesktopSessions(): readonly string[] {
    return [...new Set(watched.values())];
}
