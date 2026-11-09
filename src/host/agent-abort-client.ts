import { attachAgent } from "./attached-client.ts";
import { connectHost } from "./connection.ts";
import { listAgentPageThroughHost } from "./agent-list-client.ts";
import { processIsAlive } from "./process-identity.ts";
import { parseAgentLocationReply } from "./protocol.ts";

export async function abortAgentThroughHost(
    socketPath: string,
    agentId: string,
): Promise<void> {
    const client = await attachAgent({ socketPath, agentId });
    try {
        const initial = await client.receive();
        if (initial.type !== "history") {
            throw new Error("Attached agent did not begin with history");
        }
        await client.send({ type: "abort" });
    } finally {
        if (!client.closed) {
            await client.detach().catch(() => client.close());
        }
    }
}

export async function abortPoolAgentThroughHost(
    socketPath: string,
    agentId: string,
): Promise<"no_turn" | undefined> {
    const connection = await connectHost({ socketPath });
    let response: ReturnType<typeof parseAgentLocationReply>;
    try {
        await connection.send({ type: "locate_agent", agent_id: agentId });
        response = parseAgentLocationReply(JSON.stringify(
            await connection.receiveWithin(2_000, "Host session location deadline exceeded"),
        ));
    } finally {
        connection.close();
    }
    if (response === undefined) throw new Error("Host returned an invalid session location");
    if (response.type === "agent_location_failed") {
        if (response.reason === "worker_unavailable") {
            const listing = await listAgentPageThroughHost(socketPath);
            const row = listing.agents.find((agent) => agent.id === agentId);
            if (row?.worker_pid !== undefined && !processIsAlive(row.worker_pid)) return "no_turn";
        }
        throw new Error(response.message);
    }
    await abortAgentThroughHost(socketPath, agentId);
    return undefined;
}
