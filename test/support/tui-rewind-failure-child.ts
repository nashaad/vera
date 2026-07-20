import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type {
    AgentUpdate,
    ClientCommand,
} from "../../src/engine/protocol.ts";

const updates = new AsyncQueue<AgentUpdate>();
updates.push({ type: "history", entries: [], seq: 0 });

const client: TuiAgentClient = {
    async send(command: ClientCommand): Promise<void> {
        if (command.type === "list_timeline") {
            throw new Error("timeline unavailable");
        }
    },
    receive(signal) {
        return updates.receive(signal);
    },
    async detach(): Promise<void> {},
    close(): void {},
};

await startTui({ client });
