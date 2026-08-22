import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
    startTui,
    type TuiAgentClient,
    type TuiDependencies,
} from "../../clients/tui/main.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import { FauxAdapter } from "./faux-adapter.ts";

export function createTuiExtensionCommandDependencies(
    home: string,
): TuiDependencies {
    const channel = createInProcessChannel();
    void runHeadlessLoop(
        channel.engine,
        new FauxAdapter([]),
        "test",
        "high",
        {
            approvalMode: "auto",
        },
        {
            readModelSettings: () => ({
                model: "test",
                reasoningEffort: "high",
                contextWindow: 100,
            }),
            readApprovalMode: () => "auto",
            updateApprovalMode: async () => undefined,
            router: {
                updateModelSettings: async () => undefined,
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
        async listExtensionCommands() {
            await Bun.sleep(1_000);
            return [{
                name: "hello",
                description: "Say hello from an extension",
                usage: "/hello [name]",
                source: "test.extension",
            }];
        },
        async runExtensionCommand(command, argumentsText) {
            await Bun.sleep(250);
            if (argumentsText === "fail") {
                throw new Error("extension failed for test");
            }
            await writeFile(
                join(home, "extension-command-result.txt"),
                `${command}\n${argumentsText}`,
            );
            return {
                version: 1,
                source: "test.extension/hello",
                body: {
                    kind: "notice",
                    level: "info",
                    text: `Hello ${argumentsText}`,
                },
            };
        },
        async detach(): Promise<void> {},
        close(): void {},
    };

    return { client };
}

if (import.meta.main) {
    await startTui(
        createTuiExtensionCommandDependencies(process.env.HOME ?? ""),
    );
}
