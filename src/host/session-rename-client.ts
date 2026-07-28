import { connectHost } from "./connection.ts";

export type RenameSessionResult =
    | { readonly status: "renamed"; readonly name: string | null }
    | {
        readonly status: "rejected";
        readonly reason: "invalid" | "busy" | "not_found" | "failed";
    };

export async function renameSessionThroughHost(
    socketPath: string,
    targetAgentId: string,
    name: string | null,
): Promise<RenameSessionResult> {
    try {
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({
                type: "rename_session",
                target_agent_id: targetAgentId,
                name,
            });
            const response = asRecord(await connection.receive());
            if (
                response?.type === "session_renamed"
                && response.agent_id === targetAgentId
                && (response.name === null
                    || (typeof response.name === "string"
                        && response.name.length > 0))
            ) {
                return {
                    status: "renamed",
                    name: response.name as string | null,
                };
            }
            if (
                response?.type === "session_rename_rejected"
                && response.agent_id === targetAgentId
                && isRenameRejection(response.reason)
            ) {
                return { status: "rejected", reason: response.reason };
            }
            throw new Error("Host returned an invalid session rename response");
        } finally {
            connection.close();
        }
    } catch {
        return { status: "rejected", reason: "failed" };
    }
}

function isRenameRejection(
    value: unknown,
): value is "invalid" | "busy" | "not_found" | "failed" {
    return value === "invalid"
        || value === "busy"
        || value === "not_found"
        || value === "failed";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
