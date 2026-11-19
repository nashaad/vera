import { randomUUID } from "node:crypto";
import type { TuiAgentClient } from "../agent-client.ts";
import { appendTuiNotice } from "../state.ts";
import { reportConnectionError } from "./focus-switch.ts";
import { renderState } from "./render-state.ts";
import type { TuiRuntime } from "./runtime.ts";

/** /effort on the start screen. The composer clears whether or not the level is kept. */
export function holdHomeReasoningEffort(
    rt: TuiRuntime,
    reasoningEffort: string,
): void {
    rt.composer.clearComposer();
    rt.homeReasoningEffort = reasoningEffort;
    rt.state = appendTuiNotice(
        rt.state,
        `reasoning effort set, used when the conversation starts: ${reasoningEffort}`,
    );
    renderState(rt);
}

/** Sends the held level to the conversation that has just replaced the start screen. */
export function applyHeldReasoningEffort(
    rt: TuiRuntime,
    next: TuiAgentClient,
    reasoningEffort: string,
): void {
    const requestId = randomUUID();
    const patch = { reasoningEffort };
    rt.requestedModelChanges.set(requestId, {
        subject: `reasoning to ${reasoningEffort}`,
        patch,
        target: next,
    });
    void next.send({ type: "update_model_settings", requestId, patch })
        .catch((error) => reportConnectionError(rt, error));
}
