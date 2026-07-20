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
            if (update.type === "task_notification") {
                // This one-shot command prints only the turn it requested.
                continue;
            }
            if (update.type === "ui_request") {
                throw new Error(
                    "Agent needs an interactive response; use vera attach instead",
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
