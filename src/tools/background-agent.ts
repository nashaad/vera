import type { RegisteredTool } from "./types.ts";

export const backgroundAgentTool: RegisteredTool = {
    parallel: true,
    effectType: "spawn_background_agent",
    permissionOperation: "agent.spawn",
    definition: {
        name: "background_agent",
        description: "Launch a background agent and return its ID immediately. Its final summary arrives on a later turn.",
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
                "background_agent tool requires a string description",
            );
        }
        return {
            kind: "effect",
            effect: {
                type: "spawn_background_agent",
                description,
            },
        };
    },
};
