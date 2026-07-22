import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";

const updates = new AsyncQueue<AgentUpdate>();
updates.push({ type: "history", entries: [], seq: 0 });
updates.push({ type: "status", state: "working", seq: 1 });
updates.fail(new Error("Host sent a non-contiguous agent update sequence"));

const client: TuiAgentClient = {
    async send(): Promise<void> {},
    receive(signal): Promise<AgentUpdate> {
        return updates.receive(signal);
    },
    async detach(): Promise<void> {},
    close(): void {},
};

await startTui({ client });
