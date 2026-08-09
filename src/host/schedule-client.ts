import { connectHost } from "./connection.ts";
import type { ScheduleOperation } from "../scheduler/types.ts";

export async function runScheduleOperationThroughHost(
    socketPath: string,
    operation: ScheduleOperation,
    responseTimeoutMs = 2_000,
): Promise<Record<string, unknown>> {
    const connection = await connectHost({ socketPath });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        await connection.send({ type: "schedule_operation", operation });
        const response = asRecord(await Promise.race([
            connection.receive(),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error("Host schedule deadline exceeded"));
                }, responseTimeoutMs);
            }),
        ]));
        if (
            response?.type === "schedule_failed"
            && typeof response.reason === "string"
        ) {
            throw new Error(response.reason);
        }
        const result = asRecord(response?.result);
        if (response?.type !== "schedule_result" || result === undefined) {
            throw new Error("Host returned an invalid schedule result");
        }
        return result;
    } finally {
        clearTimeout(timeout);
        connection.close();
    }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
