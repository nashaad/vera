import { connectHost } from "./connection.ts";

export async function setSessionArchivedThroughHost(
    socketPath: string, agentId: string, archived: boolean,
): Promise<boolean> {
    const connection = await connectHost({ socketPath });
    try {
        await connection.send({ type: "set_session_archived", target_agent_id: agentId, archived });
        const response = await connection.receive();
        if (typeof response !== "object" || response === null) return false;
        const value = response as Record<string, unknown>;
        return value.type === "session_archived" && value.agent_id === agentId && value.archived === archived;
    } finally {
        connection.close();
    }
}
