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
                    description: "Model id for the subagent, on this agent's provider. Defaults to this agent's model.",
                },
                reasoning_effort: {
                    type: "string",
                    description: "Reasoning effort for the subagent. Defaults to this agent's effort.",
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
