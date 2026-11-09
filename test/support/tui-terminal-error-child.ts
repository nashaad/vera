import { writeFileSync } from "node:fs";
import { join } from "node:path";

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
import { installTestProcessGuard } from "./self-terminate-guard.ts";

export function createTuiTerminalErrorDependencies(): TuiDependencies {
    const home = process.env.VERA_HOME;
    if (home !== undefined && home.length > 0) {
        try {
            writeFileSync(join(home, "config.json"), JSON.stringify({
                schema_version: 1,
                provider: "faux",
                model: "test",
                approval_mode: "auto",
                providers: {
                    faux: {
                        protocol: "openai-chat",
                        base_url: "http://127.0.0.1:1/v1",
                        credential: "none",
                    },
                },
            }), { flag: "wx" });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
    }
    const source = {
        provider: "faux",
        api: "scripted",
        model: "test",
    } as const;
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

    return { client };
}

if (import.meta.main) {
    installTestProcessGuard();
    await startTui(createTuiTerminalErrorDependencies());
}
