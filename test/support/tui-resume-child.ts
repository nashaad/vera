import { join } from "node:path";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";

import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";

/**
 * The picker prints this as a relative age, so a fixed date would render
 * differently every day and the test asserts on that label. 90 minutes floors to
 * "1h ago" with plenty of slack for a slow start.
 */
const updatedAt = new Date(Date.now() - 90 * 60_000).toISOString();

let detached = false;
let resumedPath = "none";
const firstClient: TuiAgentClient = {
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
            title: "The one already open",
            updated_at: new Date().toISOString(),
        },
        {
            id: "target-session-id",
            workspace: "/work/vera",
            session_path: "/sessions/target.jsonl",
            kind: "interactive",
            status: "idle",
            title: "Continue the theme picker",
            updated_at: updatedAt,
        },
    ],
    resumeSession: async (sessionPath) => {
        resumedPath = sessionPath;
        const updates = new AsyncQueue<AgentUpdate>();
        updates.push({
            type: "history",
            entries: [{ kind: "assistant", text: "RESUMED HISTORY LOADED" }],
            seq: 0,
        });
        return {
            agentId: "target-session-id",
            async send(): Promise<void> {},
            receive(signal) {
                return updates.receive(signal);
            },
            async detach(): Promise<void> {},
            close(): void {},
        };
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
