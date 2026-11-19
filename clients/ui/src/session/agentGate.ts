import type { CatalogReply } from "../customize/wire.ts";

// What a session opened for a named agent has heard back about switching to it.
export interface AgentStart {
    // The agent the session was asked to switch to; undefined when nothing was asked.
    readonly name?: string;
    // True once the session confirmed the switch.
    readonly selected: boolean;
    // The session's reason when it refused the switch.
    readonly refused?: string;
}

export const NO_AGENT_START: AgentStart = { selected: false };

export type AgentGateStep =
    | { readonly kind: "wait" }
    | { readonly kind: "send" }
    | { readonly kind: "restore"; readonly reason: string };

// Folds one frame of the session into the start. Only the answer to the switch that was asked counts.
export function startAfterReply(start: AgentStart, reply: CatalogReply, asked: string | undefined): AgentStart {
    if (asked === undefined || reply.requestId !== asked) return start;
    if (reply.type === "agent_rejected") return { ...start, refused: reply.reason };
    if (reply.type === "agent_selected") return { ...start, selected: true };
    return start;
}

// What a first prompt held for an agent switch does next. It goes out only once the session confirms
// the agent it was held for; a refusal gives the text back with the session's reason.
export function stepAgentGate(start: AgentStart, heldFor: string): AgentGateStep {
    if (start.name !== heldFor) return { kind: "wait" };
    if (start.refused !== undefined) return { kind: "restore", reason: start.refused };
    return start.selected ? { kind: "send" } : { kind: "wait" };
}
