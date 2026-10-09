import type { SessionEndHookPayload, SessionEndReason } from "../../sdk/hooks.ts";
import { sessionIsSubagent, type SessionStore } from "../../store/session-store.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import type { RegisteredAgentEntry } from "./support.ts";
import { startsTurn } from "./turn-finished.ts";

// Call after the entry's run settles. A failed loop is a crash, not an end.
export function announceSessionEnd(
    reg: AgentRegistry,
    entry: RegisteredAgentEntry,
    reason: SessionEndReason,
): void {
    if (
        entry.sessionEnded
        || entry.ephemeral
        || entry.failure !== undefined
        || entry.agent.failed
    ) {
        return;
    }
    entry.sessionEnded = true;
    const onSessionEnd = reg.options.onSessionEnd;
    if (onSessionEnd === undefined) {
        return;
    }
    try {
        onSessionEnd(sessionEndPayload(entry.store, reason));
    } catch {
        // An observer must not stop a close.
    }
}

export function sessionEndPayload(
    store: SessionStore,
    reason: SessionEndReason,
): SessionEndHookPayload {
    const turns = store.activeEntries()
        .filter((entry) => startsTurn(entry.message))
        .length;
    return {
        type: "session_end",
        sessionId: store.header.id,
        workspace: store.header.cwd,
        reason,
        turns,
        spawned: sessionIsSubagent(store.header),
    };
}
