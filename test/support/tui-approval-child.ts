import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type {
    AgentUpdate,
    ClientCommand,
} from "../../src/engine/protocol.ts";

const requestId = "long-approval";
const updates = new AsyncQueue<AgentUpdate>();
updates.push({ type: "history", entries: [], seq: 0 });
updates.push({
    type: "ui_request",
    requestId,
    request: {
        type: "tool_approval",
        toolCall: {
            id: "call-1",
            name: "bash",
            input: {
                command: `grep -rli -i "${"prompt.assembly|".repeat(20)}" /Users/nash/Projects/Obsidian/Private/PROJECTS/Vera-Agent --include="*.md"`,
            },
        },
        reason: "This command searches project notes outside the workspace.",
        warning: "If allowed, this command runs with your full user permissions.",
    },
    seq: 1,
});
updates.push({
    type: "permissions",
    requestId: "permissions-after-approval",
    mode: "approve_for_me",
    pending: false,
    seq: 2,
});

const client: TuiAgentClient = {
    async send(command: ClientCommand): Promise<void> {
        if (command.type === "ui_response" && command.requestId === requestId) {
            updates.push({ type: "ui_request_closed", requestId, seq: 3 });
        }
    },
    receive(signal) {
        return updates.receive(signal);
    },
    async detach(): Promise<void> {},
    close(): void {},
};

await startTui({ client });
