import { connectHost } from "./connection.ts";
import type { BlockSessionOutcome, UnblockSessionOutcome } from "./server.ts";

export async function blockSessionThroughHost(
    socketPath: string,
    request: {
        readonly targetAgentId: string;
        readonly sessionIds: readonly string[];
        readonly reason: string | null;
    },
): Promise<BlockSessionOutcome> {
    try {
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({
                type: "block_session",
                target_agent_id: request.targetAgentId,
                session_ids: request.sessionIds,
                reason: request.reason,
            });
            const response = asRecord(await connection.receive());
            if (
                response?.type === "session_blocked"
                && response.agent_id === request.targetAgentId
                && Array.isArray(response.session_ids)
            ) {
                return {
                    status: "blocked",
                    sessionIds: response.session_ids.filter(
                        (id): id is string => typeof id === "string",
                    ),
                };
            }
            if (
                response?.type === "session_block_rejected"
                && response.agent_id === request.targetAgentId
                && (response.reason === "not_found" || response.reason === "failed")
            ) {
                return { status: "rejected", reason: response.reason };
            }
            return { status: "rejected", reason: "failed" };
        } finally {
            connection.close();
        }
    } catch {
        return { status: "rejected", reason: "failed" };
    }
}

export async function unblockSessionThroughHost(
    socketPath: string,
    request: {
        readonly targetAgentId: string;
        readonly sessionIds: readonly string[];
    },
): Promise<UnblockSessionOutcome> {
    try {
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({
                type: "unblock_session",
                target_agent_id: request.targetAgentId,
                session_ids: request.sessionIds,
            });
            const response = asRecord(await connection.receive());
            if (
                response?.type === "session_unblocked"
                && response.agent_id === request.targetAgentId
                && Array.isArray(response.session_ids)
            ) {
                return {
                    status: "unblocked",
                    sessionIds: response.session_ids.filter(
                        (id): id is string => typeof id === "string",
                    ),
                };
            }
            if (
                response?.type === "session_unblock_rejected"
                && response.agent_id === request.targetAgentId
                && (response.reason === "not_found" || response.reason === "failed")
            ) {
                return { status: "rejected", reason: response.reason };
            }
            return { status: "rejected", reason: "failed" };
        } finally {
            connection.close();
        }
    } catch {
        return { status: "rejected", reason: "failed" };
    }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
