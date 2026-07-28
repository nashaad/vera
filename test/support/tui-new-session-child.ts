import { join } from "node:path";

import { startTui } from "../../clients/tui/main.ts";
import { createSettingsAnsweringClient } from "./settings-answering-client.ts";

let detached = false;
let nextDetached = false;
let createAttempts = 0;
let createdForWorkspace = "none";
const client = createSettingsAnsweringClient({
    agentId: "current-session-id",
    workspace: "/work/vera",
    model: "current-model",
    mode: "review",
    onDetach: () => {
        detached = true;
    },
});

const exit = await startTui({
    client,
    createSession: async (workspace) => {
        createAttempts += 1;
        createdForWorkspace = workspace;
        if (createAttempts === 1) {
            throw new Error("host refused creation");
        }
        await Bun.sleep(400);
        return createSettingsAnsweringClient({
            agentId: "new-session-id",
            workspace,
            model: "fresh-model",
            mode: "full_access",
            onDetach: () => {
                nextDetached = true;
            },
        });
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
