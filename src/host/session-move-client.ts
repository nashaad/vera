import { connectHost } from "./connection.ts";

// Inlined rather than imported from protocol.ts, which would pull the host into the desktop build.
export type MoveRejectionReason = "invalid" | "busy" | "not_found" | "collision" | "failed";

export type MoveSessionResult =
    | { readonly status: "moved"; readonly workspace: string }
    | {
        readonly status: "rejected";
        readonly reason: MoveRejectionReason;
    };

export async function moveSessionThroughHost(
    socketPath: string,
    sessionId: string,
    workspace: string,
): Promise<MoveSessionResult> {
    try {
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({
                type: "move_session",
                session_id: sessionId,
                workspace,
            });
            const response = asRecord(await connection.receive());
            if (
                response?.type === "session_moved"
                && response.session_id === sessionId
                && typeof response.workspace === "string"
                && response.workspace.length > 0
            ) {
                return { status: "moved", workspace: response.workspace };
            }
            if (
                response?.type === "session_move_rejected"
                && response.session_id === sessionId
                && isMoveRejection(response.reason)
            ) {
                return { status: "rejected", reason: response.reason };
            }
            throw new Error("Host returned an invalid session move response");
        } finally {
            connection.close();
        }
    } catch {
        return { status: "rejected", reason: "failed" };
    }
}

function isMoveRejection(value: unknown): value is MoveRejectionReason {
    return value === "invalid"
        || value === "busy"
        || value === "not_found"
        || value === "collision"
        || value === "failed";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
