import type { TuiState } from "./state.ts";

export const AUTO_NUDGE_LINE = "You've allowed every request so far. Switch to Approve for me?";
export const AUTO_NUDGE_KEY = "a";
const REMEMBERED_SESSIONS = 200;

// The line shows once per session in this client, and only while the host still suggests it.
export function autoNudgeWanted(
    state: TuiState,
    agentId: string | undefined,
    shown: ReadonlySet<string>,
): boolean {
    return state.suggestAuto === true && agentId !== undefined && !shown.has(agentId);
}

export function rememberAutoNudge(shown: Set<string>, agentId: string | undefined): void {
    if (agentId === undefined) {
        return;
    }
    shown.delete(agentId);
    shown.add(agentId);
    while (shown.size > REMEMBERED_SESSIONS) {
        const oldest = shown.values().next().value;
        if (oldest === undefined) {
            break;
        }
        shown.delete(oldest);
    }
}
