import { join } from "node:path";

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
}, {
    path: join(process.env.HOME ?? "", "missing-client-extension"),
    enabled: true,
    config: null,
}] as const;
const disabledBuiltinExtensions = [
    "vera.model-presets",
    "vera.reasoning-cycle",
] as const;

await startTui({
    client,
    disabledBuiltinExtensions,
    clientExtensions: extensions,
    loadClientExtensionConfiguration() {
        return {
            disabledBuiltinExtensions,
            clientExtensions: extensions,
        };
    },
});
