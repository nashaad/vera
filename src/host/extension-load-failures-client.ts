import { connectHost } from "./connection.ts";

export interface HostExtensionLoadFailure {
    readonly extensionId: string;
    readonly message: string;
}

// A host that predates this request answers protocol_error; it reports no failures.
export async function readExtensionLoadFailuresThroughHost(
    socketPath: string,
    responseTimeoutMs = 2_000,
): Promise<readonly HostExtensionLoadFailure[]> {
    const connection = await connectHost({ socketPath });
    connection.expectPeerClose();
    try {
        await connection.send({ type: "extension_load_failures" });
        const response = asRecord(await connection.receiveWithin(
            responseTimeoutMs,
            "Host extension status deadline exceeded",
        ));
        if (response?.type === "protocol_error") return [];
        if (
            response?.type !== "extension_load_failures"
            || !Array.isArray(response.failures)
        ) {
            throw new Error("Host returned an invalid extension status");
        }
        const failures: HostExtensionLoadFailure[] = [];
        for (const value of response.failures) {
            const failure = asRecord(value);
            if (
                typeof failure?.extension_id !== "string"
                || typeof failure.message !== "string"
            ) {
                throw new Error("Host returned an invalid extension status");
            }
            failures.push({
                extensionId: failure.extension_id,
                message: failure.message,
            });
        }
        return failures;
    } finally {
        connection.close();
    }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
