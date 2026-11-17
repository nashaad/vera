import type { TuiState } from "./state.ts";

export type TuiSessionLeaveDisposition = "stop" | "keep_running";

export function hasSessionCloseWork(
    state: Pick<TuiState, "working" | "compactingSince">,
    pendingRequest: boolean,
): boolean {
    return state.working || state.compactingSince !== undefined || pendingRequest;
}

export interface TuiSessionLeaveResult {
    readonly sourceOutcome: "detached" | "stopped";
    readonly remainingInteractiveClients: number;
}
