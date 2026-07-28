import type { RegisteredAgentSummary } from "./agent-registry.ts";
import { connectHost } from "./connection.ts";

export async function listAgentsThroughHost(
    socketPath: string,
    responseTimeoutMs = 2_000,
): Promise<RegisteredAgentSummary[]> {
    const connection = await connectHost({ socketPath });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        await connection.send({ type: "list_agents" });
        const response = asRecord(await Promise.race([
            connection.receive(),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error("Host agent list deadline exceeded"));
                }, responseTimeoutMs);
            }),
        ]));
        if (
            response?.type !== "agent_list"
            || !Array.isArray(response.agents)
            || !response.agents.every(isAgentSummary)
        ) {
            throw new Error("Host returned an invalid agent list");
        }
        return response.agents;
    } finally {
        clearTimeout(timeout);
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
        && (agent.kind === "interactive" || agent.kind === "background")
        && (
            agent.status === "idle"
            || agent.status === "working"
            || agent.status === "waiting"
            || agent.status === "completed"
            || agent.status === "closed"
            || agent.status === "failed"
        )
        && (agent.title === undefined || typeof agent.title === "string")
        && (
            agent.forked_from === undefined
            || (
                typeof agent.forked_from === "string"
                && agent.forked_from.length > 0
            )
        )
        && (
            agent.updated_at === undefined
            || (
                typeof agent.updated_at === "string"
                && !Number.isNaN(Date.parse(agent.updated_at))
            )
        );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
