import { connectHost } from "./connection.ts";
import type { CutStopWaitResponse } from "./protocol.ts";

export type CutStopWaitOutcome =
    | CutStopWaitResponse
    | { readonly type: "unsupported" };

export async function cutStopWaitThroughHost(socketPath: string): Promise<CutStopWaitOutcome> {
    try {
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({ type: "cut_stop_wait" });
            return parseCutStopWaitResponse(await connection.receive());
        } finally {
            connection.close();
        }
    } catch {
        return { type: "unsupported" };
    }
}

export function parseCutStopWaitResponse(value: unknown): CutStopWaitOutcome {
    const record = asRecord(value);
    if (record?.type === "cut_stop_wait_done" && Array.isArray(record.cut) && Array.isArray(record.failed)) {
        const cut = record.cut.filter((id): id is string => typeof id === "string");
        const failed = record.failed.flatMap((entry) => {
            const item = asRecord(entry);
            return typeof item?.session_id === "string" && typeof item.message === "string"
                ? [{ session_id: item.session_id, message: item.message }]
                : [];
        });
        return { type: "cut_stop_wait_done", cut, failed };
    }
    if (
        record?.type === "cut_stop_wait_refused"
        && record.reason === "no_wait"
        && typeof record.message === "string"
    ) {
        return { type: "cut_stop_wait_refused", reason: "no_wait", message: record.message };
    }
    return { type: "unsupported" };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
