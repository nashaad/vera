import { join } from "node:path";

import { startTui } from "../../clients/tui/main.ts";
import { createSettingsAnsweringClient } from "./settings-answering-client.ts";

let detached = false;
let forkBoundary = "";
let forkedFrom = "none";

const client = createSettingsAnsweringClient({
    agentId: "source-session",
    model: "source-model",
    mode: "review",
    onCommand: (command, push) => {
        if (command.type !== "list_timeline") return;
        push({
            type: "timeline",
            requestId: command.requestId,
            boundaries: [{
                userMessageId: "prompt-1",
                timestamp: "2026-07-23T12:00:00.000Z",
                prompt: "edit this prompt",
                position: 0,
                attachments: [{ id: "image-1" }],
            }],
        });
    },
    onDetach: () => {
        detached = true;
    },
});

const exit = await startTui({
    client,
    forkSession: async (agentId, boundaryId) => {
        forkedFrom = agentId;
        forkBoundary = boundaryId;
        if (process.env.FORK_TIMEOUT === "1"
            || process.env.FORK_TIMEOUT === "hold") {
            return new Promise(() => {});
        }
        await Bun.sleep(300);
        return {
            client: createSettingsAnsweringClient({
                agentId: "forked-session",
                model: "forked-model",
                mode: "full_access",
            }),
            prompt: {
                role: "user",
                content: [
                    { type: "text", text: "edit this prompt" },
                    { type: "image_attachment", attachmentId: "image-1" },
                ],
            },
        };
    },
    ...(process.env.FORK_TIMEOUT === "1"
        ? { sessionSwitchTimeoutMs: 100 }
        // "hold" keeps the switch pending for the whole test, which is the
        // only way to press ctrl+c while one is in flight.
        : process.env.FORK_TIMEOUT === "hold"
        ? { sessionSwitchTimeoutMs: 60_000 }
        : {}),
});

await Bun.write(
    join(process.env.HOME ?? ".", "fork-session-result.txt"),
    JSON.stringify({
        agentId: exit.agentId,
        detached,
        forkBoundary,
        forkedFrom,
    }),
);
