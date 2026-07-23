import { join } from "node:path";

import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";

let detached = false;
let nextDetached = false;
let createAttempts = 0;
const client: TuiAgentClient = {
    agentId: "current-session-id",
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
    createSession: async () => {
        createAttempts += 1;
        if (createAttempts === 1) {
            throw new Error("host refused creation");
        }
        await Bun.sleep(400);
        return {
            agentId: "new-session-id",
            async send(): Promise<void> {},
            receive(): Promise<never> {
                return new Promise(() => {});
            },
            async detach(): Promise<void> {
                nextDetached = true;
            },
            close(): void {},
        };
    },
});

await Bun.write(
    join(process.env.HOME ?? ".", "new-session-result.txt"),
    [
        exit.nextClient?.agentId ?? "none",
        detached ? "detached" : "attached",
        nextDetached ? "next detached" : "next attached",
        `attempts ${createAttempts}`,
    ].join("\n"),
);
