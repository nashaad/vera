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
import { ProviderFailureError } from "../../src/model/provider-failure.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
} from "../../src/model/types.ts";
import { FauxAdapter } from "./faux-adapter.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";

/**
 * "empty": every turn reasons and says nothing, the way a badly served model does.
 * "rejected": every request comes back HTTP 400, a failure with its own Fix line.
 */
export function createTuiModelFailureDependencies(
    mode: "empty" | "rejected" = "empty",
): TuiDependencies {
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
    const rejecting: ModelAdapter = {
        stream(): ModelEventStream {
            const stream = new ModelEventStream();
            const error = new ProviderFailureError({
                kind: "invalid_request",
                resolution: "none",
                message: "The crow dropped the request in a storm.",
                statusCode: 400,
                providerMessage: "The crow dropped the request in a storm.",
            }, new Error("HTTP 400"));
            stream.push({ type: "start" });
            stream.push({
                type: "error",
                error,
                message: { ...thinkingOnly, content: [], stopReason: "error", errorMessage: error.message },
            });
            return stream;
        },
    };
    const channel = createInProcessChannel();
    void runHeadlessLoop(
        channel.engine,
        mode === "rejected"
            ? rejecting
            : new FauxAdapter([thinkingOnly, thinkingOnly, thinkingOnly]),
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
