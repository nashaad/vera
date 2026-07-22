import { attachAgent } from "./attached-client.ts";
import { randomUUID } from "node:crypto";

export interface SendPromptOptions {
    readonly attachmentPaths?: readonly string[];
}

export async function sendPromptThroughHost(
    socketPath: string,
    agentId: string,
    content: string,
    options: SendPromptOptions = {},
): Promise<string> {
    const client = await attachAgent({ socketPath, agentId });
    try {
        const initial = await client.receive();
        if (initial.type !== "history") {
            throw new Error("Attached agent did not begin with history");
        }

        const attachmentIds: string[] = [];
        for (const path of options.attachmentPaths ?? []) {
            const requestId = randomUUID();
            await client.send({ type: "attach_image", requestId, path });
            while (true) {
                const update = await client.receive();
                if (
                    (update.type === "image_attached"
                        || update.type === "image_attachment_rejected")
                    && update.requestId === requestId
                ) {
                    if (update.type === "image_attachment_rejected") {
                        throw new Error(`Could not attach ${path}: ${update.error}`);
                    }
                    attachmentIds.push(update.attachment.id);
                    break;
                }
            }
        }
        await client.send({
            type: "prompt",
            content,
            ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
        });
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
