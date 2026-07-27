import { join } from "node:path";

import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import { FauxAdapter } from "./faux-adapter.ts";

let settings: ModelTurnSettings = {
    provider: "openrouter",
    model: "moonshotai/kimi-k3",
    reasoningEffort: "low",
};
const channel = createInProcessChannel();
void runHeadlessLoop(
    channel.engine,
    new FauxAdapter([]),
    settings.model,
    settings.reasoningEffort,
    {
        approvalMode: "auto",
        readModelSettings: () => settings,
        updateModelSettings: async (patch) => {
            settings = {
                ...settings,
                ...(patch.provider === undefined
                    ? {}
                    : { provider: patch.provider }),
                ...(patch.model === undefined ? {} : { model: patch.model }),
                ...(patch.reasoningEffort === undefined
                    ? {}
                    : {
                        reasoningEffort:
                            patch.reasoningEffort ?? undefined,
                    }),
            };
            await Bun.write(
                join(process.env.HOME ?? "", "user-preset-settings.json"),
                JSON.stringify(settings),
            );
            return settings;
        },
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => "auto",
    },
);

const client: TuiAgentClient = {
    workspace: process.cwd(),
    async send(command): Promise<void> {
        channel.client.send(command);
    },
    receive(signal) {
        return channel.client.receive(signal);
    },
    async detach(): Promise<void> {},
    close(): void {},
};

await startTui({
    client,
});
