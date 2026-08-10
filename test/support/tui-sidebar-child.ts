import { join } from "node:path";
import { writeFileSync } from "node:fs";

import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import { FauxAdapter } from "./faux-adapter.ts";

const channel = createInProcessChannel();
void runHeadlessLoop(
    channel.engine,
    new FauxAdapter([]),
    "test",
    "high",
    {
        approvalMode: "auto",
        readModelSettings: () => ({
            model: "test",
            reasoningEffort: "high",
            contextWindow: 100,
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

const extensions = [{
    path: join(import.meta.dir, "fixtures/sidebar-extension"),
    enabled: true,
    config: null,
}] as const;

await startTui({
    client,
    clientExtensions: extensions,
    loadClientExtensionConfiguration() {
        writeFileSync(
            join(process.env.HOME ?? "", "client-extensions-reloaded.txt"),
            "reloaded",
        );
        return {
            disabledBuiltinExtensions: [],
            clientExtensions: extensions,
        };
    },
});
