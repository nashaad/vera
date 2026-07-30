import type { ModelMessage } from "./types.ts";

/**
 * Every call answered, every answer called for, in that order, exactly once.
 *
 * Assembled message lists (a compaction projection, a rewound branch) can drop
 * half of a tool round anywhere inside them, not only at the seam, and a
 * provider refuses the whole request either way. Order and multiplicity are
 * part of the contract: a result before its call, a duplicate call ID, or two
 * results for one call are refused just as an unmatched pair is. `subject`
 * names what is being checked so the message points at the producer.
 */
export function assertToolCallsPaired(
    messages: readonly ModelMessage[],
    subject: string,
): void {
    /** Calls seen so far, flipped to true once their result arrives. */
    const answered = new Map<string, boolean>();
    for (const message of messages) {
        if (message.role === "tool_result") {
            const state = answered.get(message.toolCallId);
            if (state === undefined) {
                throw new Error(
                    `${subject} answers tool call ${message.toolCallId} `
                        + "before it is made",
                );
            }
            if (state) {
                throw new Error(
                    `${subject} answers tool call ${message.toolCallId} twice`,
                );
            }
            answered.set(message.toolCallId, true);
            continue;
        }
        if (message.role !== "assistant") continue;
        for (const part of message.content) {
            if (part.type !== "tool_call") continue;
            if (answered.has(part.id)) {
                throw new Error(
                    `${subject} makes tool call ${part.id} twice`,
                );
            }
            answered.set(part.id, false);
        }
    }
    for (const [id, state] of answered) {
        if (!state) {
            throw new Error(`${subject} leaves tool call ${id} unanswered`);
        }
    }
}
