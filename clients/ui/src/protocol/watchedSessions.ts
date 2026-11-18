import type { DesktopBridge, SessionPane } from "./bridge.ts";

const watched = new Map<"main" | "companion", string>();

export function watchDesktopSession(bridge: DesktopBridge, pane: SessionPane, agentId: string): void {
    if (pane === "main" || pane === "companion") watched.set(pane, agentId);
    bridge.watchSession(pane, agentId);
}

export function unwatchDesktopSession(bridge: DesktopBridge, pane: SessionPane): void {
    if (pane === "main" || pane === "companion") watched.delete(pane);
    bridge.unwatchSession(pane);
}

export function watchedDesktopSessions(): readonly string[] {
    return [...new Set(watched.values())];
}
