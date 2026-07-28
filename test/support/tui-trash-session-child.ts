import { join } from "node:path";

import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";

let trashed = "";
let listCalls = 0;
const client: TuiAgentClient = {
    agentId: "current-session",
    async send(): Promise<void> {},
    receive(): Promise<never> {
        return new Promise(() => {});
    },
    async detach(): Promise<void> {},
    close(): void {},
};

await startTui({
    client,
    listAgents: async () => {
        listCalls += 1;
        if (listCalls > 1) {
            await Bun.sleep(300);
        }
        return trashed.length === 0
            ? [{
                id: "saved-session",
                workspace: "/work/vera",
                session_path: "/sessions/saved.jsonl",
                kind: "interactive" as const,
                status: "idle" as const,
                live: false,
                title: "Continue the theme picker",
                updated_at: "2026-07-20T20:00:00.000Z",
            }]
            : [];
    },
    trashSession: async (sessionId) => {
        if (process.env.TRASH_BUSY === "1") {
            return { status: "rejected", reason: "busy" };
        }
        trashed = sessionId;
        return { status: "trashed" };
    },
});

await Bun.write(
    join(process.env.HOME ?? ".", "trash-session-result.txt"),
    `${trashed}\nlist calls ${listCalls}`,
);
