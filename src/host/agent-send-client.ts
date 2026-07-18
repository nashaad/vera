import { attachAgent } from "./attached-client.ts";

export async function sendPromptThroughHost(
    socketPath: string,
    agentId: string,
    content: string,
): Promise<string> {
    const client = await attachAgent({ socketPath, agentId });
    try {
        const initial = await client.receive();
        if (initial.type !== "history") {
            throw new Error("Attached agent did not begin with history");
        }

        await client.send({ type: "prompt", content });
        let response = "";
        while (true) {
            const update = await client.receive();
            if (update.type === "assistant_delta") {
                response += update.text;
            }
            if (update.type === "ui_request") {
                throw new Error(
                    "Agent needs interactive approval; use vera attach instead",
                );
            }
            if (update.type === "turn_finished") {
                return response;
            }
        }
    } finally {
        if (!client.closed) {
            await client.detach().catch(() => client.close());
        }
    }
}
