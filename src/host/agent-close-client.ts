import { connectHost } from "./connection.ts";

export type CloseAgentResult =
    | {
        readonly status: "closed";
        readonly sessionRetained: boolean;
    }
    | {
        readonly status: "rejected";
        readonly reason: "not_found" | "not_owned" | "failed";
    };

export async function closeAgentThroughHost(
    socketPath: string,
    targetAgentId: string,
): Promise<CloseAgentResult> {
    try {
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({
                type: "close_agent",
                target_agent_id: targetAgentId,
            });
            const response = asRecord(await connection.receive());
            if (
                response?.type === "agent_closed"
                && response.agent_id === targetAgentId
            ) {
                return {
                    status: "closed",
                    sessionRetained: response.session_retained !== false,
                };
            }
            if (
                response?.type === "agent_close_rejected"
                && response.agent_id === targetAgentId
                && isCloseRejection(response.reason)
            ) {
                return { status: "rejected", reason: response.reason };
            }
            throw new Error("Host returned an invalid agent close response");
        } finally {
            connection.close();
        }
    } catch {
        return { status: "rejected", reason: "failed" };
    }
}

function isCloseRejection(
    value: unknown,
): value is "not_found" | "not_owned" | "failed" {
    return value === "not_found"
        || value === "not_owned"
        || value === "failed";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
