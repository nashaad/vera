import { join } from "node:path";

import { startTui } from "../../clients/tui/main.ts";
import { createSettingsAnsweringClient } from "./settings-answering-client.ts";

/**
 * The picker prints this as a relative age, so a fixed date would render
 * differently every day and the test asserts on that label. 90 minutes floors to
 * "1h ago" with plenty of slack for a slow start.
 */
const updatedAt = new Date(Date.now() - 90 * 60_000).toISOString();

let detached = false;
let resumedPath = "none";
const firstClient = createSettingsAnsweringClient({
    agentId: "current-session-id",
    model: "current-model",
    mode: "review",
    onDetach: () => {
        detached = true;
    },
});

// One startTui call for the whole run. Switching sessions no longer ends the
// TUI, so a second call here would be exercising a handover that cannot happen.
const exit = await startTui({
    client: firstClient,
    listAgents: async () => [
        {
            id: "current-session-id",
            workspace: "/work/vera",
            session_path: "/sessions/current.jsonl",
            kind: "interactive",
            status: "idle",
            live: false,
            title: "The one already open",
            updated_at: new Date().toISOString(),
        },
        {
            id: "target-session-id",
            workspace: "/work/vera",
            session_path: "/sessions/target.jsonl",
            kind: "interactive",
            status: "idle",
            live: false,
            title: "Continue the theme picker",
            updated_at: updatedAt,
        },
    ],
    resumeSession: async (sessionPath) => {
        resumedPath = sessionPath;
        // The resumed session runs a different model in full access: the
        // status line has to report both as soon as the transcript lands.
        return createSettingsAnsweringClient({
            agentId: "target-session-id",
            model: "resumed-model",
            mode: "full_access",
            initialUpdates: [{
                type: "history",
                entries: [{ kind: "assistant", text: "RESUMED HISTORY LOADED" }],
                seq: 0,
            }],
        });
    },
});

await Bun.write(
    join(process.env.HOME ?? ".", "resume-result.txt"),
    [
        resumedPath,
        detached ? "detached" : "attached",
        exit.agentId ?? "none",
    ].join("\n"),
);
