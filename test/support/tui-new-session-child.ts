import { join } from "node:path";

import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";

let detached = false;
let nextDetached = false;
let createAttempts = 0;
let createdForWorkspace = "none";
const client: TuiAgentClient = {
    agentId: "current-session-id",
    workspace: "/work/vera",
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
    createSession: async (workspace) => {
        createAttempts += 1;
        createdForWorkspace = workspace;
        if (createAttempts === 1) {
            throw new Error("host refused creation");
        }
        await Bun.sleep(400);
        return {
            agentId: "new-session-id",
            workspace,
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
        // The session attached at exit, which is the new one: the TUI switched
        // to it in place rather than closing and asking to be started again.
        exit.agentId ?? "none",
        detached ? "detached" : "attached",
        nextDetached ? "next detached" : "next attached",
        `attempts ${createAttempts}`,
        createdForWorkspace,
    ].join("\n"),
);
