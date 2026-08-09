import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import {
    emptyUsage,
    type AssistantMessage,
} from "../../src/model/types.ts";
import { FauxAdapter } from "./faux-adapter.ts";

const responses: AssistantMessage[] = [
    response(`PARTIAL ${"x".repeat(200)} FIRST-END`),
    thinkingResponse("WEIGHING THE ORDERINGS", "STEER WORKED"),
];
const channel = createInProcessChannel();
void runHeadlessLoop(
    channel.engine,
    new FauxAdapter(responses, { chunkSize: 1, delayMs: 40 }),
    "test",
    "high",
    {
        approvalMode: "auto",
        readModelSettings: () => ({
            model: "test",
            reasoningEffort: "high",
            contextWindow: 100,
        }),
        updateModelSettings: async () => undefined,
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
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

await startTui({ client, copyText: async () => undefined });

function thinkingResponse(
    reasoning: string,
    text: string,
): AssistantMessage {
    const message = response(text);
    return {
        ...message,
        content: [{ type: "thinking", text: reasoning }, ...message.content],
    };
}

function response(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: { ...emptyUsage(), inputTokens: 25 },
        stopReason: "stop",
    };
}
