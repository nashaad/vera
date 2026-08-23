import {
    startTui,
    type TuiAgentClient,
    type TuiDependencies,
} from "../../clients/tui/main.ts";
import { resolveTuiAppearance } from "../../clients/tui/appearance.ts";
import { loadOptionalVeraConfig } from "../../src/config.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import {
    emptyUsage,
    type AssistantMessage,
} from "../../src/model/types.ts";
import { FauxAdapter } from "./faux-adapter.ts";

export function createTuiToolDetailsDependencies(): TuiDependencies {
    const source = { provider: "faux", api: "scripted", model: "test" } as const;
    const output = Array.from(
        { length: 10 },
        (_, index) => `TOOL_DETAIL_${String(index).padStart(2, "0")}`,
    ).join("\\n");
    const responses: AssistantMessage[] = [
        {
            role: "assistant",
            content: [{
                type: "tool_call",
                id: "long-tool-output",
                name: "bash",
                input: { command: `printf '${output}\\n'` },
            }],
            source,
            usage: emptyUsage(),
            stopReason: "tool_use",
        },
        {
            role: "assistant",
            content: [{ type: "text", text: "TOOL DETAILS COMPLETED" }],
            source,
            usage: emptyUsage(),
            stopReason: "stop",
        },
        {
            role: "assistant",
            content: [{
                type: "tool_call",
                id: "short-tool-output",
                name: "bash",
                input: { command: "printf 'SHORT_DETAIL\\n'" },
            }],
            source,
            usage: emptyUsage(),
            stopReason: "tool_use",
        },
        {
            role: "assistant",
            content: [{ type: "text", text: "SHORT TOOL COMPLETED" }],
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
        { approvalMode: "ask" },
        {},
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

    return {
        client,
        appearance: resolveTuiAppearance(loadOptionalVeraConfig()?.tui),
    };
}

if (import.meta.main) {
    await startTui(createTuiToolDetailsDependencies());
}
