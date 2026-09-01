import type { ModelMessage } from "./types.ts";

export function assertToolCallsPaired(
    messages: readonly ModelMessage[],
    subject: string,
): void {
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
