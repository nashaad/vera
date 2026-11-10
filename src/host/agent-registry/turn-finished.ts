import type { TurnFinishedUpdate } from "../../engine/protocol.ts";
import type { ModelMessage } from "../../model/types.ts";
import type { TurnFinishedHookPayload } from "../../sdk/hooks.ts";
import {
    sessionIsSubagent,
    sessionTurnTextPart,
    startsSessionTurn,
    type SessionMessageEntry,
    type SessionStore,
} from "../../store/session-store.ts";

export function turnFinishedPayload(
    store: SessionStore,
    update: TurnFinishedUpdate,
): TurnFinishedHookPayload {
    const entries = store.activeEntries();
    let turnStart = -1;
    entries.forEach((entry, index) => {
        if (startsTurn(entry.message)) {
            turnStart = index;
        } else if (entry.deliveryId !== undefined) {
            // A turn started by a delivery begins at it, so it has an empty prompt and only its own reply.
            turnStart = index;
        }
    });
    const carried = turnStart < 0 ? store.carriedTurnText() : undefined;
    const turn = turnStart < 0 && carried === undefined ? [] : entries.slice(Math.max(0, turnStart));
    return {
        type: "turn_finished",
        sessionId: store.header.id,
        workspace: store.header.cwd,
        outcome: update.outcome ?? "completed",
        turns: store.turnCount(),
        spawned: sessionIsSubagent(store.header),
        prompt: [...(carried?.prompt ?? []), ...turnText(turn, "user")].join("\n\n"),
        reply: [...(carried?.reply ?? []), ...turnText(turn, "assistant")].join("\n\n"),
    };
}

// Messages typed while a turn runs join that turn instead of starting one.
export function startsTurn(message: ModelMessage): boolean {
    return startsSessionTurn(message);
}

function turnText(
    entries: readonly SessionMessageEntry[],
    role: "user" | "assistant",
): string[] {
    const parts: string[] = [];
    for (const { message } of entries) {
        if (message.role !== role) continue;
        const part = sessionTurnTextPart(message);
        if (part?.role === role) parts.push(part.text);
    }
    return parts;
}
