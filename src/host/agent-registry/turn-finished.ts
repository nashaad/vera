import type { TurnFinishedUpdate } from "../../engine/protocol.ts";
import type { ModelMessage } from "../../model/types.ts";
import type { TurnFinishedHookPayload } from "../../sdk/hooks.ts";
import {
    sessionIsSubagent,
    type SessionMessageEntry,
    type SessionStore,
} from "../../store/session-store.ts";

export function turnFinishedPayload(
    store: SessionStore,
    update: TurnFinishedUpdate,
): TurnFinishedHookPayload {
    const entries = store.activeEntries();
    let turns = 0;
    let turnStart = -1;
    entries.forEach((entry, index) => {
        if (startsTurn(entry.message)) {
            turns += 1;
            turnStart = index;
        }
    });
    // A turn with no prompt of its own (a delivery or a resume) has an empty prompt.
    const turn = turnStart < 0 ? [] : entries.slice(turnStart);
    return {
        type: "turn_finished",
        sessionId: store.header.id,
        workspace: store.header.cwd,
        outcome: update.outcome ?? "completed",
        turns,
        spawned: sessionIsSubagent(store.header),
        prompt: joinText(turn, "user"),
        reply: joinText(turn, "assistant"),
    };
}

// Messages typed while a turn runs join that turn instead of starting one.
export function startsTurn(message: ModelMessage): boolean {
    return message.role === "user"
        && message.internal !== true
        && message.contextSource === undefined
        && message.arrivedDuringTurn !== true;
}

function joinText(
    entries: readonly SessionMessageEntry[],
    role: "user" | "assistant",
): string {
    const parts: string[] = [];
    for (const { message } of entries) {
        if (message.role !== role || message.internal === true) {
            continue;
        }
        if (message.role === "user" && message.contextSource !== undefined) {
            continue;
        }
        const text = message.content
            .map((content) => content.type === "text" ? content.text : "")
            .join("")
            .trim();
        if (text.length > 0) {
            parts.push(text);
        }
    }
    return parts.join("\n\n");
}
