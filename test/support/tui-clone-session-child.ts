import { join } from "node:path";

import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";

let detached = false;
let cloneAttempts = 0;
let clonedFrom = "none";
const client: TuiAgentClient = {
    agentId: "source-session",
    async send(): Promise<void> {},
    receive(): Promise<never> {
        return new Promise(() => {});
    },
    async detach(): Promise<void> {
        detached = true;
    },
    close(): void {},
};

const exit = await startTui({
    client,
    cloneSession: async (agentId) => {
        cloneAttempts += 1;
        clonedFrom = agentId;
        await Bun.sleep(400);
        return {
            agentId: "cloned-session",
            async send(): Promise<void> {},
            receive(): Promise<never> {
                return new Promise(() => {});
            },
            async detach(): Promise<void> {},
            close(): void {},
        };
    },
});

await Bun.write(
    join(process.env.HOME ?? ".", "clone-session-result.txt"),
    [
        exit.agentId ?? "none",
        detached ? "detached" : "attached",
        `attempts ${cloneAttempts}`,
        clonedFrom,
    ].join("\n"),
);
