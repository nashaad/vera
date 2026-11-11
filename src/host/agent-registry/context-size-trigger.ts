import type { ContextSizeTriggerEvent } from "../../engine/events.ts";
import type { ContextSizeTriggerHookPayload } from "../../sdk/hooks.ts";
import { sessionIsSubagent, type SessionStore } from "../../store/session-store.ts";

export function contextSizeTriggerPayload(
    store: SessionStore,
    event: ContextSizeTriggerEvent,
): ContextSizeTriggerHookPayload {
    return {
        type: "context_size_trigger",
        sessionId: store.header.id,
        workspace: store.header.cwd,
        reason: event.reason,
        ...(event.policy === undefined
            ? {}
            : { policy: { id: event.policy.id, kind: event.policy.kind } }),
        actions: [...event.actions],
        tokens: event.tokens,
        tokensAfter: event.tokensAfter,
        ...(event.capacity === undefined ? {} : { capacity: event.capacity }),
        spawned: sessionIsSubagent(store.header),
    };
}
