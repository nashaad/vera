import type { RegisteredTool } from "./types.ts";
import { spawnModelChoice } from "./spawn-model-choice.ts";

export const subagentTool: RegisteredTool = {
    parallel: true,
    effectType: "spawn_subagent",
    permissionOperation: "agent.spawn",
    definition: {
        name: "subagent",
        description: "Launch a focused subagent and return only its final summary.",
        inputSchema: {
            type: "object",
            properties: {
                description: { type: "string" },
                model: {
                    type: "string",
                    description: "A pooled model id (provider/model) to run the subagent on. Defaults to this agent's model.",
                },
                reasoning_effort: {
                    type: "string",
                    description: "Reasoning effort for the subagent, from the chosen model's levels. Defaults to this agent's effort.",
                },
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
                ...spawnModelChoice("subagent", input),
            },
        };
    },
};
