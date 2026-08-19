import {
    startTui,
    type TuiAgentClient,
    type TuiDependencies,
} from "../../clients/tui/main.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";

export function createTuiConnectionErrorDependencies(): TuiDependencies {
    const updates = new AsyncQueue<AgentUpdate>();
    updates.push({ type: "history", entries: [], seq: 0 });
    updates.push({ type: "status", state: "working", seq: 1 });
    updates.fail(new Error("Host sent a non-contiguous agent update sequence"));

    const client: TuiAgentClient = {
        agentId: "agent-1",
        async send(): Promise<void> {},
        receive(signal): Promise<AgentUpdate> {
            return updates.receive(signal);
        },
        async detach(): Promise<void> {},
        close(): void {},
    };

    return {
        client,
        reconnectSession: async () => {
            const reconnectedUpdates = new AsyncQueue<AgentUpdate>();
            reconnectedUpdates.push({
                type: "history",
                entries: [{ kind: "assistant", text: "Host reconnected." }],
                seq: 0,
            });
            reconnectedUpdates.push({ type: "status", state: "idle", seq: 1 });
            return {
                agentId: "agent-1",
                async send(): Promise<void> {},
                receive(signal): Promise<AgentUpdate> {
                    return reconnectedUpdates.receive(signal);
                },
                async detach(): Promise<void> {},
                close(): void {},
            };
        },
    };
}

if (import.meta.main) {
    await startTui(createTuiConnectionErrorDependencies());
}
