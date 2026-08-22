import { connectHost } from "./connection.ts";

export type CloseAgentResult =
    | {
        readonly status: "closed";
        /**
         * Whether the transcript is still on disk. An ephemeral agent's
         * session goes with it, so nothing may offer to resume that id.
         */
        readonly sessionRetained: boolean;
    }
    | {
        readonly status: "rejected";
        readonly reason: "not_found" | "not_owned" | "failed";
    };

/**
 * Ask the host to end one live agent instance.
 *
 * Resolves only after the host has acknowledged, which it does after the close
 * has reached its terminal state. Callers may repeat the request: an agent that
 * is already closed acknowledges rather than rejects.
 */
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
                // An older host does not carry the field. Its close still
                // kept the session for every agent a client can name.
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
