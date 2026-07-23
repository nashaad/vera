import { connectHost } from "./connection.ts";

export type TrashSessionResult =
    | { readonly status: "trashed" }
    | {
        readonly status: "rejected";
        readonly reason: "busy" | "not_found" | "failed";
    };

export async function trashSessionThroughHost(
    socketPath: string,
    targetAgentId: string,
): Promise<TrashSessionResult> {
    try {
        const connection = await connectHost({ socketPath });
        try {
        await connection.send({
            type: "trash_session",
            target_agent_id: targetAgentId,
        });
        const response = asRecord(await connection.receive());
        if (
            response?.type === "session_trashed"
            && response.agent_id === targetAgentId
        ) {
            return { status: "trashed" };
        }
        if (
            response?.type === "session_trash_rejected"
            && response.agent_id === targetAgentId
            && isTrashRejection(response.reason)
        ) {
            return { status: "rejected", reason: response.reason };
        }
        throw new Error("Host returned an invalid session trash response");
        } finally {
            connection.close();
        }
    } catch {
        return { status: "rejected", reason: "failed" };
    }
}

function isTrashRejection(
    value: unknown,
): value is "busy" | "not_found" | "failed" {
    return value === "busy"
        || value === "not_found"
        || value === "failed";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
