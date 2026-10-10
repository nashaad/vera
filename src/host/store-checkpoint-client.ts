import { connectHost } from "./connection.ts";

export interface StoreCheckpointOutcome {
    readonly takenAt: string;
    readonly databases: readonly string[];
}

export async function checkpointStoresThroughHost(
    socketPath: string,
    destination: string,
    responseTimeoutMs = 10_000,
): Promise<StoreCheckpointOutcome> {
    const connection = await connectHost({ socketPath });
    try {
        await connection.send({
            type: "checkpoint_stores",
            destination,
        });
        const response = asRecord(await connection.receiveWithin(
            responseTimeoutMs,
            "Host checkpoint deadline exceeded",
        ));
        if (
            response?.type === "checkpoint_stores_failed"
            && typeof response.reason === "string"
        ) {
            throw new Error(response.reason);
        }
        if (
            response?.type !== "checkpoint_stores_finished"
            || typeof response.taken_at !== "string"
            || !Array.isArray(response.databases)
            || response.databases.some((name) => typeof name !== "string")
        ) {
            throw new Error("Host returned an invalid store checkpoint");
        }
        return {
            takenAt: response.taken_at,
            databases: response.databases as readonly string[],
        };
    } finally {
        connection.close();
    }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
