import { startTui, type TuiAgentClient } from "../../clients/tui/main.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AgentUpdate, ClientCommand } from "../../src/engine/protocol.ts";

const updates = new AsyncQueue<AgentUpdate>();
updates.push({ type: "history", entries: [], seq: 0 });
updates.push({ type: "notice", key: "inbox", count: 1, seq: 1 });
updates.push({ type: "notice", key: "inbox", count: 2, seq: 2 });

const client: TuiAgentClient = {
    async send(_command: ClientCommand): Promise<void> {},
    receive(signal) {
        return updates.receive(signal);
    },
    async detach(): Promise<void> {},
    close(): void {},
};

await startTui({ client });
