import { attachAgent } from "./attached-client.ts";

export async function abortAgentThroughHost(
    socketPath: string,
    agentId: string,
): Promise<void> {
    const client = await attachAgent({ socketPath, agentId });
    try {
        const initial = await client.receive();
        if (initial.type !== "history") {
            throw new Error("Attached agent did not begin with history");
        }
        await client.send({ type: "abort" });
    } finally {
        if (!client.closed) {
            await client.detach().catch(() => client.close());
        }
    }
}
