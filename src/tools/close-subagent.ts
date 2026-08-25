import type { RegisteredTool } from "./types.ts";

export const closeSubagentTool: RegisteredTool = {
    invocation: "top_level",
    parallel: true,
    effectType: "close_subagent",
    permissionOperation: "agent.close",
    definition: {
        name: "close_subagent",
        description: [
            "Close one live descendant agent and its live descendants through",
            "the host. Returns JSON with requested_subagent_id, closed, reason,",
            "and session_retained on success.",
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                subagent_id: { type: "string" },
            },
            required: ["subagent_id"],
            additionalProperties: false,
        },
    },
    async execute(input) {
        const subagentId = input.subagent_id;
        if (typeof subagentId !== "string" || subagentId.length === 0) {
            throw new Error(
                "close_subagent requires a non-empty string subagent_id",
            );
        }
        return {
            kind: "effect",
            effect: {
                type: "close_subagent",
                subagentId,
            },
        };
    },
};
