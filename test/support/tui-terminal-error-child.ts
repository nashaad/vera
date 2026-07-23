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

const source = { provider: "faux", api: "scripted", model: "test" } as const;
const responses: AssistantMessage[] = [
    {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "read-package",
            name: "read",
            input: { path: "package.json" },
        }],
        source,
        usage: emptyUsage(),
        stopReason: "tool_use",
    },
    {
        role: "assistant",
        content: [{
            type: "thinking",
            text: "<tool_calls>not a structured call</tool_calls>",
        }],
        source,
        usage: emptyUsage(),
        stopReason: "stop",
    },
    {
        role: "assistant",
        content: [{ type: "text", text: "RECOVERED AFTER ERROR" }],
        source,
        usage: emptyUsage(),
        stopReason: "stop",
    },
];
const channel = createInProcessChannel();
void runHeadlessLoop(
    channel.engine,
    new FauxAdapter(responses),
    "test",
    "off",
    { approvalMode: "auto" },
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

await startTui({ client });
