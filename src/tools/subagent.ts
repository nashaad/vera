import type { RegisteredTool } from "./types.ts";
import { spawnModelChoice } from "./spawn-model-choice.ts";

export const subagentTool: RegisteredTool = {
    parallel: true,
    effectType: "spawn_subagent",
    permissionOperation: "agent.spawn",
    definition: {
        name: "subagent",
        description:
            "Launch a focused subagent and return only its final summary. The child does not see this conversation. Put the goal, why it matters, what you already know, paths, and what to return in `description`.",
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
                    description: "Optional model within the allowed subagent models. If omitted, the selected agent definition and configured assignments determine the model.",
                },
                reasoning_effort: {
                    type: "string",
                    description: "Reasoning effort for the subagent, from the chosen model's levels. Defaults to this agent's effort.",
                },
                agent: {
                    type: "string",
                    description: "An agent for the subagent to wear. Its tools and skills are narrowed by what this session can already reach.",
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
                ...(typeof input.agent === "string" && input.agent.length > 0
                    ? { agent: input.agent }
                    : {}),
                ...spawnModelChoice("subagent", input),
            },
        };
    },
};
