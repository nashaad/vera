import type { RegisteredAgentSummary } from "./agent-registry.ts";
import { connectHost } from "./connection.ts";

export async function listAgentsThroughHost(
    socketPath: string,
): Promise<RegisteredAgentSummary[]> {
    const connection = await connectHost({ socketPath });
    try {
        await connection.send({ type: "list_agents" });
        const response = asRecord(await connection.receive());
        if (
            response?.type !== "agent_list"
            || !Array.isArray(response.agents)
            || !response.agents.every(isAgentSummary)
        ) {
            throw new Error("Host returned an invalid agent list");
        }
        return response.agents;
    } finally {
        connection.close();
    }
}

function isAgentSummary(value: unknown): value is RegisteredAgentSummary {
    const agent = asRecord(value);
    return typeof agent?.id === "string"
        && agent.id.length > 0
        && typeof agent.workspace === "string"
        && agent.workspace.length > 0
        && typeof agent.session_path === "string"
        && agent.session_path.length > 0
        && (
            agent.status === "idle"
            || agent.status === "working"
            || agent.status === "waiting"
            || agent.status === "closed"
            || agent.status === "failed"
        );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
