import { join } from "node:path";

import { startTui } from "../../clients/tui/main.ts";
import { createSettingsAnsweringClient } from "./settings-answering-client.ts";

let detached = false;
let cloneAttempts = 0;
let clonedFrom = "none";
const client = createSettingsAnsweringClient({
    agentId: "source-session",
    model: "source-model",
    mode: "review",
    onDetach: () => {
        detached = true;
    },
});

const exit = await startTui({
    client,
    ...(process.env.CLONE_TIMEOUT === "1"
        ? { sessionSwitchTimeoutMs: 100 }
        : {}),
    cloneSession: async (agentId) => {
        cloneAttempts += 1;
        clonedFrom = agentId;
        if (process.env.CLONE_TIMEOUT === "1") {
            return new Promise(() => {});
        }
        await Bun.sleep(400);
        return createSettingsAnsweringClient({
            agentId: "cloned-session",
            model: "cloned-model",
            mode: "full_access",
        });
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
