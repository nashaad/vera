import type { RegisteredTool } from "./types.ts";

/**
 * A live read of the other sessions the host is holding for this workspace.
 * Every field is observed and there is no description field: the log is
 * the full account, so a row points at it instead of summarizing it and going
 * stale. Nothing here is declared by an agent and nothing is written down, so
 * the roster empties when the host does.
 */
export const agentRosterTool: RegisteredTool = {
    parallel: true,
    effectType: "agent_roster",
    permissionOperation: "agent.roster",
    definition: {
        name: "agent_roster",
        description: [
            "List the other vera agent sessions live on this host in the",
            "current workspace. Each row is the agent's identity name, the",
            "time it was last active, its session id, and the path to its",
            "session log. There is no description of what a session is",
            "doing: read the session log to find that out.",
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
        },
    },
    async execute() {
        return { kind: "effect", effect: { type: "agent_roster" } };
    },
};
