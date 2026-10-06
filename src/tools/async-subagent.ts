import type { RegisteredTool } from "./types.ts";
import { spawnModelChoice } from "./spawn-model-choice.ts";

export const asyncSubagentTool: RegisteredTool = {
    parallel: true,
    effectType: "spawn_async_subagent",
    permissionOperation: "agent.spawn",
    definition: {
        name: "async_subagent",
        description:
            "Launch a focused subagent concurrently and return its ID immediately. Its final summary arrives on a later turn. The child does not see this conversation. Put the goal, why it matters, what you already know, paths, and what to return in `description`.",
        inputSchema: {
            type: "object",
            properties: {
                description: {
                    type: "string",
                    description:
                        "The child's only view of the task. Include everything it needs; it cannot see this conversation.",
                },
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
