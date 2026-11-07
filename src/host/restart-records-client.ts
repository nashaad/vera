import { connectHost } from "./connection.ts";
import { RESTART_CAUSES } from "../store/restart-records.ts";
import type { RestartRecordWire } from "./protocol.ts";

export type RestartRecordDismissResult =
    | { readonly status: "dismissed"; readonly removed: number }
    | { readonly status: "failed" };

export async function listRestartRecordsThroughHost(
    socketPath: string,
    responseTimeoutMs = 2_000,
): Promise<readonly RestartRecordWire[]> {
    const connection = await connectHost({ socketPath });
    try {
        await connection.send({ type: "restart_records" });
        const response = asRecord(await connection.receiveWithin(
            responseTimeoutMs,
            "Host restart record deadline exceeded",
        ));
        if (
            response?.type !== "restart_records_list"
            || !Array.isArray(response.records)
            || !response.records.every(isRestartRecordWire)
        ) {
            throw new Error("Host returned an invalid restart record list");
        }
        return response.records;
    } finally {
        connection.close();
    }
}

export async function dismissRestartRecordThroughHost(
    socketPath: string,
    sessionId: string,
    responseTimeoutMs = 2_000,
): Promise<RestartRecordDismissResult> {
    const connection = await connectHost({ socketPath });
    try {
        await connection.send({
            type: "restart_record_dismiss",
            session_id: sessionId,
        });
        const response = asRecord(await connection.receiveWithin(
            responseTimeoutMs,
            "Host restart record dismiss deadline exceeded",
        ));
        if (
            response?.type === "restart_record_dismissed"
            && response.session_id === sessionId
            && typeof response.removed === "number"
            && Number.isSafeInteger(response.removed)
        ) {
            return { status: "dismissed", removed: response.removed };
        }
        if (
            response?.type === "restart_record_dismiss_failed"
            && response.session_id === sessionId
        ) {
            return { status: "failed" };
        }
        throw new Error("Host returned an invalid restart record dismissal");
    } finally {
        connection.close();
    }
}

function isRestartRecordWire(value: unknown): value is RestartRecordWire {
    const record = asRecord(value);
    return record !== undefined
        && typeof record.session_id === "string"
        && record.session_id.length > 0
        && RESTART_CAUSES.includes(record.cause as RestartRecordWire["cause"])
        && typeof record.at === "string"
        && !Number.isNaN(Date.parse(record.at))
        && (record.target_build_id === undefined
            || typeof record.target_build_id === "string");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
