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
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FauxAdapter } from "./faux-adapter.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";

export function createTuiAutoReviewDependencies(home: string): TuiDependencies {
    const source = { provider: "faux", api: "scripted", model: "test" } as const;
    const responses: AssistantMessage[] = [
        {
            role: "assistant",
            content: [{
                type: "tool_call",
                id: "auto-reviewed-command",
                name: "bash",
                input: { command: "env AUTO_REVIEW=ran" },
            }],
            source,
            usage: emptyUsage(),
            stopReason: "tool_use",
        },
        {
            role: "assistant",
            content: [{ type: "text", text: "AUTO REVIEW COMPLETED" }],
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
        {
            approvalMode: "auto",
        },
        {
            reviewToolCall: async () => {
                writeFileSync(
                    join(home, "auto-review-invoked"),
                    "allowed\n",
                );
                return {
                    decision: "allow",
                    reason: "Routine command requested by the user.",
                    riskLevel: "low",
                    userAuthorization: "high",
                };
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
    installTestProcessGuard();
    await startTui(createTuiAutoReviewDependencies(process.env.HOME ?? "."));
}
