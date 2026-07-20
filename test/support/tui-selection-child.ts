import { writeFileSync } from "node:fs";

import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type {
    AgentUpdate,
    ClientCommand,
} from "../../src/engine/protocol.ts";

const copiedTextPath = process.env.VERA_TEST_COPIED_TEXT_PATH;
if (copiedTextPath === undefined) {
    throw new Error("VERA_TEST_COPIED_TEXT_PATH is required");
}

const updates = new AsyncQueue<AgentUpdate>();
updates.push({
    type: "history",
    entries: [{
        kind: "assistant",
        text: "Please COPY THIS TEXT from the transcript.",
    }],
    seq: 0,
});

const client: TuiAgentClient = {
    async send(_command: ClientCommand): Promise<void> {},
    receive(signal) {
        return updates.receive(signal);
    },
    async detach(): Promise<void> {},
    close(): void {},
};

await startTui({
    client,
    copyText: async (text) => {
        writeFileSync(copiedTextPath, text);
    },
});
