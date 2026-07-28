import { join } from "node:path";

import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AgentUpdate, ClientCommand } from "../../src/engine/protocol.ts";
import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";

let savedName = "Continue the theme picker";
let currentName = "Fix the deployment race";
const hostCalls: string[] = [];
const updates = new AsyncQueue<AgentUpdate>();

const client: TuiAgentClient = {
    agentId: "current-session",
    async send(command: ClientCommand): Promise<void> {
        if (command.type === "update_session_name") {
            currentName = command.name ?? "Fix the deployment race";
            updates.push({
                type: "session_name",
                requestId: command.requestId,
                name: command.name,
            });
        }
    },
    receive(signal) {
        return updates.receive(signal);
    },
    async detach(): Promise<void> {},
    close(): void {},
};

await startTui({
    client,
    listAgents: async () => [
        {
            id: "saved-session",
            workspace: "/work/vera",
            session_path: "/sessions/saved.jsonl",
            kind: "interactive" as const,
            status: "idle" as const,
            title: savedName,
            updated_at: "2026-07-20T20:00:00.000Z",
        },
        {
            id: "current-session",
            workspace: "/work/vera",
            session_path: "/sessions/current.jsonl",
            kind: "interactive" as const,
            status: "idle" as const,
            title: currentName,
            updated_at: "2026-07-20T19:00:00.000Z",
        },
    ],
    renameSession: async (sessionId, requestedName) => {
        hostCalls.push(`${sessionId} ${requestedName ?? "(cleared)"}`);
        if (process.env.RENAME_BUSY === "1") {
            return { status: "rejected", reason: "busy" };
        }
        savedName = requestedName ?? "Continue the theme picker";
        return { status: "renamed", name: requestedName };
    },
});

await Bun.write(
    join(process.env.HOME ?? ".", "rename-session-result.txt"),
    `${hostCalls.join("\n")}\ncurrent ${currentName}`,
);
