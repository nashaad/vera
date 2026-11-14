// Sessions this window has already shown the auto-approval suggestion for. It lives in the window
// because the card that carries the line is remounted whenever the person changes session.

import type { OpenRequest } from "./requests.ts";

const REMEMBERED_SESSIONS = 200;

const shown = new Set<string>();

export function autoNudgeShown(agentId: string): boolean {
    return shown.has(agentId);
}

export function markAutoNudgeShown(agentId: string): void {
    shown.delete(agentId);
    shown.add(agentId);
    while (shown.size > REMEMBERED_SESSIONS) {
        const oldest = shown.values().next().value;
        if (oldest === undefined) break;
        shown.delete(oldest);
    }
}

export function forgetAutoNudges(): void {
    shown.clear();
}

// The approval the line sits under: the first unanswered request, when it is an approval and the window has not shown the line for this session.
export function autoNudgeTarget(first: OpenRequest | undefined, suggestAuto: boolean, seen: boolean): string | undefined {
    return suggestAuto && !seen && first?.kind === "approval" ? first.requestId : undefined;
}
