import type { ModelMessage } from "./types.ts";

/**
 * Every call answered, every answer called for.
 *
 * Assembled message lists (a compaction projection, a rewound branch) can drop
 * half of a tool round anywhere inside them, not only at the seam, and a
 * provider refuses the whole request either way. `subject` names what is being
 * checked so the message points at the producer.
 */
export function assertToolCallsPaired(
    messages: readonly ModelMessage[],
    subject: string,
): void {
    const answered = new Set(
        messages.flatMap((message) =>
            message.role === "tool_result" ? [message.toolCallId] : []
        ),
    );
    const called = new Set<string>();
    for (const message of messages) {
        if (message.role !== "assistant") continue;
        for (const part of message.content) {
            if (part.type !== "tool_call") continue;
            called.add(part.id);
            if (!answered.has(part.id)) {
                throw new Error(
                    `${subject} leaves tool call ${part.id} unanswered`,
                );
            }
        }
    }
    for (const id of answered) {
        if (!called.has(id)) {
            throw new Error(`${subject} answers absent tool call ${id}`);
        }
    }
}
