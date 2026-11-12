import { randomUUID } from "node:crypto";
import type { TuiAgentClient } from "../agent-client.ts";
import { appendTuiError, appendTuiNotice } from "../state.ts";
import { focusActiveSurface } from "./focus-switch.ts";
import { renderState } from "./render-state.ts";
import type { TuiRuntime } from "./runtime.ts";

// Mirrors the host's session name rule so a bad name is refused while it can still be retyped.
function validSessionName(name: string): boolean {
    return name.length > 0
        && !name.includes("\0")
        && Buffer.byteLength(name, "utf8") <= 200;
}

/** /rename on the start screen. The composer clears whether or not the name is kept. */
export function holdHomeSessionName(
    rt: TuiRuntime,
    requested: string | null,
): void {
    rt.composer.clearComposer();
    const name = requested?.trim();
    if (requested === null) {
        rt.homeSessionName = undefined;
        rt.state = appendTuiNotice(rt.state, "session name cleared");
    } else if (name === undefined || !validSessionName(name)) {
        rt.state = appendTuiError(
            rt.state,
            "Session name must be 1 to 200 UTF-8 bytes",
        );
    } else {
        rt.homeSessionName = name;
        rt.state = appendTuiNotice(
            rt.state,
            `session name set, used when the conversation starts: ${name}`,
        );
    }
    focusActiveSurface(rt);
    renderState(rt);
}

/** Sends the held name to the conversation that has just replaced the start screen. */
export function applyHeldSessionName(
    rt: TuiRuntime,
    next: TuiAgentClient,
    name: string,
): void {
    const requestId = randomUUID();
    rt.homeNameRequestId = requestId;
    void next.send({ type: "update_session_name", requestId, name })
        .catch(() => {
            if (rt.homeNameRequestId !== requestId) return;
            rt.homeNameRequestId = undefined;
            rt.state = appendTuiError(rt.state, "Could not rename this session");
            renderState(rt);
        });
}
