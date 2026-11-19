import { enterAction, type EnterContext } from "../composer/rules.ts";
import type { SessionWatch } from "../session/model.ts";

export type MessageEnterAction = "passthrough" | "none" | "send" | "steer";

// Enter on an empty box releases what is queued into the running turn; it never stops the subagent, which Stop does.
export function messageEnterAction(context: EnterContext): MessageEnterAction {
    const action = enterAction(context);
    if (action === "release-all") return "steer";
    if (action === "abort") return "none";
    return action;
}

export function messagePlaceholder(watch: Pick<SessionWatch, "phase" | "status">): string {
    if (watch.phase === "attaching") return "Opening the subagent";
    if (watch.phase !== "attached") return "Not connected to this subagent";
    return watch.status === "idle" ? "Message this subagent" : "Queue a message for when this turn ends";
}
