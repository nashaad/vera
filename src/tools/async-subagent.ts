import type { RegisteredTool } from "./types.ts";

export const asyncSubagentTool: RegisteredTool = {
    parallel: true,
    effectType: "spawn_async_subagent",
    permissionOperation: "agent.spawn",
    definition: {
        name: "async_subagent",
        description: "Launch a focused subagent concurrently and return its ID immediately. Its final summary arrives on a later turn.",
        inputSchema: {
            type: "object",
            properties: {
                description: { type: "string" },
            },
            required: ["description"],
            additionalProperties: false,
        },
    },
    async execute(input) {
        const description = input.description;
        if (typeof description !== "string") {
            throw new Error(
                "async_subagent tool requires a string description",
            );
        }
        return {
            kind: "effect",
            effect: {
                type: "spawn_async_subagent",
                description,
            },
        };
    },
};
