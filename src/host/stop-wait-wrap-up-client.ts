import { connectHost } from "./connection.ts";
import type { AskStopWaitWrapUpResponse, HostRequester } from "./protocol.ts";

export type RequestStopWaitWrapUpOutcome = AskStopWaitWrapUpResponse | { readonly type: "unsupported" };

export async function requestStopWaitWrapUp(
    socketPath: string,
    notes?: string,
    requester?: HostRequester,
): Promise<RequestStopWaitWrapUpOutcome> {
    try {
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({
                type: "ask_stop_wait_wrap_up",
                ...(notes === undefined ? {} : { notes }),
                ...(requester === undefined ? {} : { requester }),
            });
            return parseRequestStopWaitWrapUpResponse(await connection.receive());
        } finally {
            connection.close();
        }
    } catch {
        return { type: "unsupported" };
    }
}

export function parseRequestStopWaitWrapUpResponse(value: unknown): RequestStopWaitWrapUpOutcome {
    const record = asRecord(value);
    if (record?.type === "ask_stop_wait_wrap_up_done" && Array.isArray(record.offered)) {
        const offered = record.offered.filter((id): id is string => typeof id === "string");
        return { type: "ask_stop_wait_wrap_up_done", offered };
    }
    if (record?.type === "ask_stop_wait_wrap_up_refused"
        && record.reason === "no_wait" && typeof record.message === "string") {
        return { type: "ask_stop_wait_wrap_up_refused", reason: "no_wait", message: record.message };
    }
    return { type: "unsupported" };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
