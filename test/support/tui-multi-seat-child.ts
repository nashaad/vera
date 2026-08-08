import { join } from "node:path";

import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import { FauxAdapter } from "./faux-adapter.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";

const EXTENSION = join(import.meta.dir, "../../examples/extensions/multi-seat");

/** What a seat is: a model the user already admitted, and its provider. */
const POOLED = ["advisor", "second", "broken"].map((poolName) => ({
    provider: "faux",
    model: `faux-${poolName}`,
    label: `faux-${poolName}`,
    poolName,
    available: true,
    verified: true,
    levels: [],
}));

const channel = createInProcessChannel();
void runHeadlessLoop(
    channel.engine,
    new FauxAdapter([response("AGENT ANSWERED")]),
    "test",
    "high",
    {
        approvalMode: "auto",
        readModelSettings: () => ({
            model: "test",
            reasoningEffort: "high",
            contextWindow: 100,
            pooled: POOLED,
        }),
        updateModelSettings: async () => undefined,
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
        async consult(request) {
            if (request.model === "faux-broken") {
                throw new Error("provider is down");
            }
            return {
                text: `SEAT SAW ${request.messages.at(-1)?.content ?? ""}`,
                model: request.model,
            };
        },
        sendConsultReply: (_ownerId, reply) => channel.engine.send(reply),
    },
);

const client: TuiAgentClient = {
    async send(command): Promise<void> {
        channel.client.send(command);
    },
    receive(signal) {
        return channel.client.receive(signal);
    },
    async detach(): Promise<void> {},
    close(): void {},
};

await startTui({
    client,
    clientExtensions: [{ path: EXTENSION, enabled: true, config: { maxSeats: 2 } }],
});

function response(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}
