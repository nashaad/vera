import type { TuiAgentClient } from "./agent-client.ts";

export interface TuiExtensionComposeTarget {
    readonly client: TuiAgentClient;
    readonly clientGeneration: number;
    readonly surfaceGeneration: number;
    stale: boolean;
}

export interface TuiExtensionComposeCurrentTarget {
    readonly client: TuiAgentClient;
    readonly clientGeneration: number;
    readonly surfaceGeneration: number;
    readonly sessionSwitchPending: boolean;
}

export function captureTuiExtensionComposeTarget(
    current: Omit<TuiExtensionComposeCurrentTarget, "sessionSwitchPending">,
): TuiExtensionComposeTarget {
    return { ...current, stale: false };
}

/** Once a target misses, later focus changes cannot make it current again. */
export function isCurrentTuiExtensionComposeTarget(
    target: TuiExtensionComposeTarget,
    current: TuiExtensionComposeCurrentTarget,
): boolean {
    if (target.stale) return false;
    if (
        current.sessionSwitchPending
        || target.client !== current.client
        || target.clientGeneration !== current.clientGeneration
        || target.surfaceGeneration !== current.surfaceGeneration
    ) {
        target.stale = true;
        return false;
    }
    return true;
}
