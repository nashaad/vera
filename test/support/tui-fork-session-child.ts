import { join } from "node:path";

import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";
import type {
    AgentUpdate,
    ClientCommand,
} from "../../src/engine/protocol.ts";

const updates: AgentUpdate[] = [];
let wake: (() => void) | undefined;
let detached = false;
let forkBoundary = "";
let forkedFrom = "none";

const client: TuiAgentClient = {
    agentId: "source-session",
    async send(command: ClientCommand): Promise<void> {
        if (command.type !== "list_timeline") return;
        updates.push({
            type: "timeline",
            requestId: command.requestId,
            boundaries: [{
                userMessageId: "prompt-1",
                timestamp: "2026-07-23T12:00:00.000Z",
                prompt: "edit this prompt",
                position: 0,
                attachmentIds: ["image-1"],
            }],
        });
        wake?.();
    },
    async receive(): Promise<AgentUpdate> {
        while (updates.length === 0) {
            await new Promise<void>((resolve) => {
                wake = resolve;
            });
        }
        return updates.shift()!;
    },
    async detach(): Promise<void> {
        detached = true;
    },
    close(): void {},
};

const exit = await startTui({
    client,
    forkSession: async (agentId, boundaryId) => {
        forkedFrom = agentId;
        forkBoundary = boundaryId;
        if (process.env.FORK_TIMEOUT === "1") {
            return new Promise(() => {});
        }
        await Bun.sleep(300);
        return {
            client: {
                agentId: "forked-session",
                async send(): Promise<void> {},
                receive(): Promise<never> {
                    return new Promise(() => {});
                },
                async detach(): Promise<void> {},
                close(): void {},
            },
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
