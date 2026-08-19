import {
    startTui,
    type TuiAgentClient,
    type TuiDependencies,
} from "../../clients/tui/main.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import {
    emptyUsage,
    type AssistantMessage,
} from "../../src/model/types.ts";
import { FauxAdapter } from "./faux-adapter.ts";

export function createTuiRewindDependencies(): TuiDependencies {
    const channel = createInProcessChannel();
    void runHeadlessLoop(
        channel.engine,
        new FauxAdapter([
            response("FIRST ANSWER"),
            response("SECOND ANSWER"),
        ]),
        "test",
        "high",
        {
            approvalMode: "auto",
            readModelSettings: () => ({
                model: "test",
                reasoningEffort: "high",
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

    return { client };
}

if (import.meta.main) {
    await startTui(createTuiRewindDependencies());
}

function response(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}
