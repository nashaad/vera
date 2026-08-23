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
    type ModelReasoningEffort,
} from "../../src/model/types.ts";
import { FauxAdapter } from "./faux-adapter.ts";

export function createTuiSettingsDependencies(): TuiDependencies {
    let reasoningEffort: ModelReasoningEffort = "high";
    const provider = "faux";
    // Mirrors what a real host sends since nash-50 slice 4b: the running model's
    // own levels ride along on `availableModels`, not a flat effort list.
    const availableModels = [
        {
            provider,
            model: "test",
            label: "Test model",
            description: "the faux model this fixture drives",
            levels: [
                { id: "low", label: "Low", description: "light reasoning" },
                { id: "medium", label: "Medium", description: "balanced reasoning" },
                { id: "high", label: "High", description: "deeper reasoning" },
                { id: "max", label: "Max", description: "maximum available reasoning" },
            ],
            defaultLevel: "high",
        },
    ];
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
            approvalMode: "auto",
        },
        {
            readModelSettings: () => (
                { provider, model: "test", reasoningEffort, availableModels }
            ),
            readApprovalMode: () => "auto",
            updateApprovalMode: async () => "auto",
            router: {
                updateModelSettings: async (patch) => {
                    if (patch.reasoningEffort !== undefined) {
                        reasoningEffort = patch.reasoningEffort ?? "high";
                    }
                    return {
                        provider,
                        model: "test",
                        reasoningEffort,
                        availableModels,
                    };
                },
            },
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
    await startTui(createTuiSettingsDependencies());
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
