import type { RegisteredTool } from "./types.ts";

export const subagentTool: RegisteredTool = {
    parallel: true,
    definition: {
        name: "subagent",
        description: "Launch a focused subagent and return only its final summary.",
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
            throw new Error("subagent tool requires a string description");
        }
        return {
            kind: "effect",
            effect: {
                type: "spawn_subagent",
                description,
            },
        };
    },
};
