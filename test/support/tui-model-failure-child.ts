import {
    startTui,
    type TuiAgentClient,
    type TuiDependencies,
} from "../../clients/tui/main.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import {
    defaultModelFailureLedgerPath,
    ModelFailureLedger,
} from "../../src/store/model-failures.ts";
import {
    emptyUsage,
    type AssistantMessage,
} from "../../src/model/types.ts";
import { FauxAdapter } from "./faux-adapter.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";

/** Every turn reasons and says nothing, the way a badly served model does. */
export function createTuiModelFailureDependencies(): TuiDependencies {
    const source = {
        provider: "openrouter",
        api: "openrouter-chat",
        model: "moonshotai/kimi-k3",
    } as const;
    const thinkingOnly: AssistantMessage = {
        role: "assistant",
        content: [{ type: "thinking", text: "thought hard" }],
        source,
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const channel = createInProcessChannel();
    void runHeadlessLoop(
        channel.engine,
        new FauxAdapter([thinkingOnly, thinkingOnly, thinkingOnly]),
        "moonshotai/kimi-k3",
        "off",
        {
            approvalMode: "auto",
        },
        {
            modelFailureLedger: new ModelFailureLedger(
                defaultModelFailureLedgerPath(),
            ),
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
    installTestProcessGuard();
    await startTui(createTuiModelFailureDependencies());
}
