import {
    startTui,
    type TuiAgentClient,
    type TuiDependencies,
} from "../../clients/tui/main.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";

export function createTuiFatalDiagnosticDependencies(): TuiDependencies {
    const updates = new AsyncQueue<AgentUpdate>();
    updates.push({
        type: "history",
        entries: [{
            kind: "harness",
            text: "Connection retry (×3)",
            tone: "soft",
        }],
        seq: 0,
    });
    updates.push({
        type: "tool_review",
        tool: "bash",
        decision: "deny",
        reason: "The permission gate denied this operation.",
        riskLevel: "high",
        userAuthorization: "unknown",
        seq: 1,
    });
    updates.push({
        type: "agent_failed",
        failureId: "failure-1",
        detail: "Resident agent stopped unexpectedly",
        seq: 2,
    });

    const client: TuiAgentClient = {
        agentId: "agent-1",
        async send(): Promise<void> {},
        receive(signal): Promise<AgentUpdate> {
            return updates.receive(signal);
        },
        async detach(): Promise<void> {},
        close(): void {},
    };

    return { client };
}

if (import.meta.main) {
    await startTui(createTuiFatalDiagnosticDependencies());
}
