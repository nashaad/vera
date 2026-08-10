import type { RegisteredTool } from "./types.ts";

export const MAX_PEER_MESSAGE_BYTES = 16 * 1024;

export const agentSendTool: RegisteredTool = {
    effectType: "agent_send",
    permissionOperation: "agent.message",
    definition: {
        name: "agent_send",
        description: [
            "Send a durable note to another Vera participant from agent_roster.",
            "The recipient is not woken; the result reports whether a UI notice",
            "was possible. Use reply_to to reply to a message you previously",
            "read with agent_inbox.",
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                to: { type: "string", description: "Roster participant_id." },
                text: { type: "string" },
                reply_to: { type: "integer", minimum: 1 },
            },
            required: ["to", "text"],
            additionalProperties: false,
        },
    },
    async execute(input) {
        const to = input.to;
        const text = input.text;
        const replyTo = input.reply_to;
        if (typeof to !== "string" || to.trim().length === 0) {
            throw new Error("agent_send requires a non-empty to participant_id");
        }
        if (
            typeof text !== "string"
            || text.trim().length === 0
            || encodedStringBytes(text) > MAX_PEER_MESSAGE_BYTES
        ) {
            throw new Error(
                `agent_send text must encode to at most ${MAX_PEER_MESSAGE_BYTES} bytes`,
            );
        }
        if (
            replyTo !== undefined
            && (!Number.isSafeInteger(replyTo) || (replyTo as number) <= 0)
        ) {
            throw new Error("agent_send reply_to must be a positive integer");
        }
        return {
            kind: "effect",
            effect: {
                type: "agent_send",
                to: to.trim(),
                text,
                ...(replyTo === undefined ? {} : { replyTo: replyTo as number }),
            },
        };
    },
};

function encodedStringBytes(value: string): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
}
