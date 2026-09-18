import type { JsonValue } from "../sdk/hooks.ts";
import { connectHost } from "./connection.ts";

/** Sends one extension request on its own connection. Closing it cancels the handler. */
export async function requestExtensionThroughHost(
    socketPath: string,
    extensionId: string,
    name: string,
    payload: JsonValue,
    signal: AbortSignal,
): Promise<JsonValue> {
    signal.throwIfAborted();
    const connection = await connectHost({ socketPath });
    let abort: (() => void) | undefined;
    try {
        await connection.send({ type: "extension_request", extensionId, name, payload });
        const response = await Promise.race([
            connection.receive(),
            new Promise<never>((_, reject) => {
                abort = () => reject(signal.reason ?? new Error("Cancelled"));
                signal.addEventListener("abort", abort, { once: true });
            }),
        ]);
        const record = typeof response === "object" && response !== null
            ? response as Record<string, unknown>
            : undefined;
        if (record?.type === "extension_response" && "value" in record) return record.value as JsonValue;
        if (record?.type === "extension_request_failed" && typeof record.message === "string") {
            throw new Error(record.message);
        }
        throw new Error("The host did not answer the extension request");
    } finally {
        if (abort !== undefined) signal.removeEventListener("abort", abort);
        connection.close();
    }
}
