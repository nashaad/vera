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
            "Return your own participant ID and list the other currently live",
            "vera participants in the current workspace. self_participant_id",
            "is always the caller; participants never includes the caller.",
            "The compact default returns the identity and status needed for",
            "messaging. Set details to true only when the full",
            "resident-session and repository diagnostics are needed.",
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
