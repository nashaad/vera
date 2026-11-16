import { appendFileSync } from "node:fs";
import { join } from "node:path";

import {
    startTui,
    type TuiAgentClient,
    type TuiDependencies,
} from "../../clients/tui/main.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type {
    AgentUpdate,
    ClientCommand,
} from "../../src/engine/protocol.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";

export function createTuiApprovalDependencies(): TuiDependencies {
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
        mode: "auto",
        pending: false,
        seq: 2,
    });

    const client: TuiAgentClient = {
        async send(command: ClientCommand): Promise<void> {
            if (command.type === "ui_response" && command.requestId === requestId) {
                updates.push({ type: "ui_request_closed", requestId, seq: 3 });
                updates.push({
                    type: "assistant_delta",
                    text: "RESPONSE AFTER APPROVAL",
                    seq: 4,
                });
                updates.push({ type: "turn_finished", seq: 5 });
            }
        },
        receive(signal) {
            return updates.receive(signal);
        },
        async detach(): Promise<void> {},
        close(): void {},
    };

    return { client };
}

// Records every command the client sends, so a test can see the answer and the mode change, in order.
export function createTuiSwitchApprovalDependencies(home: string): TuiDependencies {
    const requestId = "switch-approval";
    const updates = new AsyncQueue<AgentUpdate>();
    updates.push({ type: "history", entries: [], seq: 0 });
    updates.push({
        type: "permissions",
        requestId: "permissions-before-approval",
        mode: "ask",
        pending: false,
        inspection: {
            selected: { name: "ask", rules: [], defaultOutcome: "ask" },
            availableModes: ["readonly", "ask", "auto"],
            activeGrants: [],
        },
        seq: 1,
    });
    updates.push({
        type: "ui_request",
        requestId,
        request: {
            type: "tool_approval",
            toolCall: {
                id: "call-1",
                name: "bash",
                input: { command: "grep -rn needle ." },
            },
            reason: "This command reads files outside the workspace.",
            warning: "",
            permissionGrants: [{
                kind: "command",
                when: { tool: "bash", executable: "grep" },
                scope: "session",
                lifetime: "session",
            }],
        },
        seq: 2,
    });

    const client: TuiAgentClient = {
        async send(command: ClientCommand): Promise<void> {
            appendFileSync(join(home, "sent.jsonl"), `${JSON.stringify(command)}\n`);
            if (command.type === "ui_response" && command.requestId === requestId) {
                updates.push({ type: "ui_request_closed", requestId, seq: 3 });
                updates.push({
                    type: "assistant_delta",
                    text: "RESPONSE AFTER APPROVAL",
                    seq: 4,
                });
                updates.push({ type: "turn_finished", seq: 5 });
            }
        },
        receive(signal) {
            return updates.receive(signal);
        },
        async detach(): Promise<void> {},
        close(): void {},
    };

    return { client };
}

if (import.meta.main) {
    installTestProcessGuard();
    await startTui(createTuiApprovalDependencies());
}
