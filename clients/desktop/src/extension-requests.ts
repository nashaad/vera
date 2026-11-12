import { connectHost, type HostConnection } from "../../../src/host/connection.ts";
import type { ExtensionFailure, ExtensionFailuresResult } from "../../ui/src/protocol/bridge.ts";

const FAILURES_TIMEOUT_MS = 5_000;
// The host lists one entry per configured extension; more than this is a reply this client refuses.
const MAX_FAILURES = 200;
const MAX_TEXT_CHARS = 4_000;

type Fields = Record<string, unknown>;

export async function readExtensionFailures(socketPath: string | undefined): Promise<ExtensionFailuresResult> {
    if (socketPath === undefined) return { ok: false, reason: "The host is not running." };
    let connection: HostConnection | undefined;
    try {
        connection = await connectHost({ socketPath });
        await connection.send({ type: "extension_load_failures" });
        const reply = await connection.receiveWithin(FAILURES_TIMEOUT_MS, "The host did not list extension failures in time.");
        const failures = isFields(reply) && reply.type === "extension_load_failures" ? parseFailures(reply.failures) : undefined;
        return failures === undefined
            ? { ok: false, reason: "The host sent extension failures this window could not read." }
            : { ok: true, failures };
    } catch (error) {
        return { ok: false, reason: error instanceof Error && error.message.length > 0 ? error.message : "The host did not answer." };
    } finally {
        connection?.close();
    }
}

export function parseFailures(value: unknown): readonly ExtensionFailure[] | undefined {
    if (!Array.isArray(value) || value.length > MAX_FAILURES) return undefined;
    const failures: ExtensionFailure[] = [];
    for (const entry of value) {
        if (!isFields(entry) || typeof entry.extension_id !== "string" || typeof entry.message !== "string") return undefined;
        failures.push({
            extensionId: entry.extension_id.slice(0, MAX_TEXT_CHARS),
            message: entry.message.slice(0, MAX_TEXT_CHARS),
        });
    }
    return failures;
}

function isFields(value: unknown): value is Fields {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
