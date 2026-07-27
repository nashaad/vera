import {
    startTui,
    type TuiAgentClient,
} from "../../clients/tui/main.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type {
    AgentUpdate,
    ClientCommand,
} from "../../src/engine/protocol.ts";

const requestId = "child-approval";
const updates = new AsyncQueue<AgentUpdate>();
updates.push({ type: "history", entries: [], seq: 0 });
updates.push({
    type: "ui_request",
    requestId,
    request: {
        type: "tool_approval",
        toolCall: {
            id: "child-call",
            name: "bash",
            input: {
                command:
                    "printf child > /tmp/vera-child-approval-test.txt",
            },
        },
        reason:
            "Permission mode ask requires ask: write outside workspace (ask.default).",
        warning:
            "If allowed, this command and its child processes run with your full user permissions.",
        sourceAgentId: "5a5d7460-1234-5678-9abc-def012345678",
        sourceTask: "Write the child approval marker",
    },
    seq: 1,
});
updates.push({
    type: "permissions",
    requestId: "permissions-after-approval",
    mode: "ask",
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
