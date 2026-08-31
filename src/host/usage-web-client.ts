import { connectHost } from "./connection.ts";

/**
 * The loopback URL for Vera web. One request, one answer, connection closed.
 */
export async function readUsageWebUrlThroughHost(
    socketPath: string,
    responseTimeoutMs = 2_000,
): Promise<string | undefined> {
    const connection = await connectHost({ socketPath });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        await connection.send({ type: "usage_web" });
        const response = await Promise.race([
            connection.receive(),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error("Host usage web deadline exceeded"));
                }, responseTimeoutMs);
            }),
        ]);
        const record = typeof response === "object" && response !== null
            ? response as Record<string, unknown>
            : undefined;
        return typeof record?.url === "string" && record.type === "usage_web"
            ? record.url
            : undefined;
    } finally {
        clearTimeout(timeout);
        connection.close();
    }
}
