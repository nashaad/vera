import { appendTuiError } from "../state.ts";
import { currentDraft, renderState } from "../main.ts";
import { beginHostReconnect } from "./focus-switch.ts";
import type { TuiRuntime } from "./runtime.ts";

export interface LostHostRestartInput {
    readonly connectionFailed: boolean;
    readonly sessionSwitchPending: boolean;
    readonly agentId: string | undefined;
    readonly relaunchAvailable: boolean;
    readonly installedBuildId: string | undefined;
    readonly clientBuildId: string | undefined;
    readonly reconnectAvailable: boolean;
}

export type LostHostRestartPlan =
    | { readonly kind: "none" }
    | { readonly kind: "relaunch" }
    | { readonly kind: "reconnect" }
    | { readonly kind: "unavailable" };

// A relaunch needs the installed build to differ from this TUI's build. Without a launcher the
// installed build is never read, so the reconnect path runs.
export function lostHostRestartPlan(input: LostHostRestartInput): LostHostRestartPlan {
    if (!input.connectionFailed || input.sessionSwitchPending || input.agentId === undefined) {
        return { kind: "none" };
    }
    if (
        input.relaunchAvailable
        && input.installedBuildId !== undefined
        && input.installedBuildId !== input.clientBuildId
    ) {
        return { kind: "relaunch" };
    }
    return input.reconnectAvailable ? { kind: "reconnect" } : { kind: "unavailable" };
}

export function lostHostRestartFailure(message: string, agentId: string): string {
    const sentence = /[.!?]$/.test(message) ? message : `${message}.`;
    return `Could not restart the host: ${sentence} To continue this session, run: vera resume ${agentId}`;
}

export function restartLostHost(rt: TuiRuntime): void {
    const agentId = rt.client.agentId;
    const relaunch = rt.dependencies.relaunchTui;
    const plan = lostHostRestartPlan({
        connectionFailed: rt.connectionFailed,
        sessionSwitchPending: rt.sessionSwitchPending,
        agentId,
        relaunchAvailable: relaunch !== undefined,
        installedBuildId: relaunch === undefined ? undefined : rt.dependencies.installedBuildId?.(),
        clientBuildId: rt.dependencies.clientBuildId,
        reconnectAvailable: rt.dependencies.reconnectSession !== undefined,
    });
    if (plan.kind === "none" || agentId === undefined) {
        return;
    }
    const failureText = (message: string): string => lostHostRestartFailure(message, agentId);
    if (plan.kind === "relaunch" && relaunch !== undefined) {
        const draft = currentDraft(rt);
        relaunch({ sessionId: agentId, ...(draft === undefined ? {} : { draft }) })
            .catch((error: unknown) => {
                if (rt.shuttingDown) return;
                const message = error instanceof Error ? error.message : String(error);
                rt.state = appendTuiError(rt.state, failureText(message));
                renderState(rt);
                rt.composer.focus();
            });
        return;
    }
    if (plan.kind === "unavailable") {
        rt.state = appendTuiError(rt.state, failureText("this client cannot start a host"));
        renderState(rt);
        rt.composer.focus();
        return;
    }
    beginHostReconnect(rt, { clearComposer: false, manual: true, failureText });
}
