import type { RegisteredTool } from "./types.ts";

export const messageSubagentTool: RegisteredTool = {
    parallel: true,
    effectType: "message_subagent",
    permissionOperation: "agent.message",
    definition: {
        name: "message_subagent",
        description: "Queue additional context for one of your running async subagents.",
        inputSchema: {
            type: "object",
            properties: {
                subagent_id: { type: "string" },
                message: { type: "string" },
            },
            required: ["subagent_id", "message"],
            additionalProperties: false,
        },
    },
    async execute(input) {
        const subagentId = input.subagent_id;
        const message = input.message;
        if (typeof subagentId !== "string" || typeof message !== "string") {
            throw new Error(
                "message_subagent requires string subagent_id and message",
            );
        }
        return {
            kind: "effect",
            effect: {
                type: "message_subagent",
                subagentId,
                message,
            },
        };
    },
};
