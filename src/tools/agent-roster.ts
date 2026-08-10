import type { RegisteredTool } from "./types.ts";

/**
 * A live read of the other sessions the host is holding for this workspace.
 * Nothing here is declared by an agent and nothing is written down, so the
 * roster empties when the host does. Ordinary calls stay compact; diagnostic
 * callers can explicitly request the full observed host and repository facts.
 */
export const agentRosterTool: RegisteredTool = {
    parallel: true,
    effectType: "agent_roster",
    permissionOperation: "agent.roster",
    definition: {
        name: "agent_roster",
        description: [
            "List the other vera agent sessions the host is holding in the",
            "current workspace. The compact default returns the identity and",
            "live status needed for messaging. Set details to true only when",
            "repository, activity, inbox, or session diagnostics are needed.",
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                details: {
                    type: "boolean",
                    description: "Include full repository and session diagnostics.",
                },
            },
            additionalProperties: false,
        },
    },
    async execute(input) {
        return {
            kind: "effect",
            effect: { type: "agent_roster", details: input.details === true },
        };
    },
};
