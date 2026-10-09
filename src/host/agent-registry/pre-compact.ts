import type { CompactionUpdate } from "../../engine/protocol.ts";
import type { PreCompactHookPayload } from "../../sdk/hooks.ts";
import { sessionIsSubagent, type SessionStore } from "../../store/session-store.ts";

// Undefined for an update that is not a started compaction, so nothing fires on the finished phase.
export function preCompactPayload(
    store: SessionStore,
    update: CompactionUpdate,
): PreCompactHookPayload | undefined {
    if (
        update.phase !== "started"
        || update.trigger === undefined
        || update.tokens === undefined
    ) {
        return undefined;
    }
    return {
        type: "pre_compact",
        sessionId: store.header.id,
        workspace: store.header.cwd,
        reason: update.trigger,
        tokens: update.tokens,
        ...(update.capacity === undefined ? {} : { capacity: update.capacity }),
        spawned: sessionIsSubagent(store.header),
    };
}
