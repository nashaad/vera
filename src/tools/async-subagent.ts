import type { RegisteredTool } from "./types.ts";
import { spawnModelChoice } from "./spawn-model-choice.ts";

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
            throw new Error(
                "async_subagent tool requires a string description",
            );
        }
        return {
            kind: "effect",
            effect: {
                type: "spawn_async_subagent",
                description,
                ...spawnModelChoice("async_subagent", input),
            },
        };
    },
};
