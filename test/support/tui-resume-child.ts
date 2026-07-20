import { join } from "node:path";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";

import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";

let detached = false;
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

const exit = await startTui({
    client: firstClient,
    listAgents: async () => [{
        id: "target-session-id",
        workspace: "/work/vera",
        session_path: "/sessions/target.jsonl",
        kind: "interactive",
        status: "idle",
        title: "Continue the theme picker",
        updated_at: "2026-07-20T20:00:00.000Z",
    }],
});

await Bun.write(
    join(process.env.HOME ?? ".", "resume-result.txt"),
    exit.resumeSessionPath ?? "none",
);

if (!detached) {
    throw new Error("The first TUI did not detach before switching");
}

const updates = new AsyncQueue<AgentUpdate>();
updates.push({
    type: "history",
    entries: [{ kind: "assistant", text: "RESUMED HISTORY LOADED" }],
    seq: 0,
});
const resumedClient: TuiAgentClient = {
    agentId: "target-session-id",
    async send(): Promise<void> {},
    receive(signal) {
        return updates.receive(signal);
    },
    async detach(): Promise<void> {},
    close(): void {},
};

await startTui({ client: resumedClient });
