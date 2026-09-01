import type { RegisteredTool } from "./types.ts";

export const notifyParentTool: RegisteredTool = {
    parallel: true,
    effectType: "notify_parent",
    permissionOperation: "agent.message",
    definition: {
        name: "notify_parent",
        description: "Send a durable message to the parent agent when its attention or a decision is needed.",
        inputSchema: {
            type: "object",
            properties: {
                message: { type: "string" },
            },
            required: ["message"],
            additionalProperties: false,
        },
    },
    async execute(input) {
        const message = input.message;
        if (typeof message !== "string") {
            throw new Error("notify_parent requires a string message");
        }
        return {
            kind: "effect",
            effect: {
                type: "notify_parent",
                message,
            },
        };
    },
};
