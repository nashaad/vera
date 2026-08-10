import type { RegisteredTool } from "./types.ts";

export const agentInboxTool: RegisteredTool = {
    effectType: "agent_inbox",
    permissionOperation: "agent.inbox",
    definition: {
        name: "agent_inbox",
        description: [
            "Explicitly read the next unread inbox entry. Reading is sequential:",
            "message_id may identify the next entry but cannot skip earlier mail.",
            "The durable offset advances only after the returned result is stored.",
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                message_id: { type: "integer", minimum: 1 },
            },
            additionalProperties: false,
        },
    },
    async execute(input) {
        const messageId = input.message_id;
        if (
            messageId !== undefined
            && (!Number.isSafeInteger(messageId) || (messageId as number) <= 0)
        ) {
            throw new Error("agent_inbox message_id must be a positive integer");
        }
        return {
            kind: "effect",
            effect: {
                type: "agent_inbox",
                ...(messageId === undefined
                    ? {}
                    : { messageId: messageId as number }),
            },
        };
    },
};
