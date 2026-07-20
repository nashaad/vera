import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelReasoningEffort,
} from "../../src/model/types.ts";
import { FauxAdapter } from "./faux-adapter.ts";

let reasoningEffort: ModelReasoningEffort = "high";
const channel = createInProcessChannel();
void runHeadlessLoop(
    channel.engine,
    new FauxAdapter([response("SETTINGS TURN WORKED")], {
        chunkSize: 1,
        delayMs: 20,
    }),
    "test",
    reasoningEffort,
    {
        approvalMode: "approve_for_me",
        readModelSettings: () => ({ model: "test", reasoningEffort }),
        updateModelSettings: async (patch) => {
            if (patch.reasoningEffort !== undefined) {
                reasoningEffort = patch.reasoningEffort ?? "high";
            }
            return { model: "test", reasoningEffort };
        },
        readApprovalMode: () => "approve_for_me",
        updateApprovalMode: async () => "approve_for_me",
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

await startTui({ client });

function response(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}
