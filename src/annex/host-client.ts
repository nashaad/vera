import { connectHost } from "../host/connection.ts";

export type AnnexUrlResult =
    | { readonly url: string }
    | { readonly unavailable: string };

export async function readAnnexUrlThroughHost(
    socketPath: string,
    responseTimeoutMs = 2_000,
): Promise<AnnexUrlResult> {
    const connection = await connectHost({ socketPath });
    connection.expectPeerClose();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        await connection.send({ type: "annex_url" });
        const response = await Promise.race([
            connection.receive(),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error("Host annex deadline exceeded"));
                }, responseTimeoutMs);
            }),
        ]);
        const record = typeof response === "object" && response !== null
            ? response as Record<string, unknown>
            : undefined;
        if (record?.type === "annex_url" && typeof record.url === "string") {
            return { url: record.url };
        }
        if (
            record?.type === "annex_unavailable"
            && typeof record.reason === "string"
        ) {
            return { unavailable: record.reason };
        }
        return {
            unavailable:
                "This host does not serve an annex. Restart the host to bring it back.",
        };
    } finally {
        clearTimeout(timeout);
        connection.close();
    }
}
