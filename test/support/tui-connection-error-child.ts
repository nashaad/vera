import {
    startTui,
    type TuiAgentClient,
    type TuiDependencies,
} from "../../clients/tui/main.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";

export interface TuiConnectionErrorOptions {
    readonly reconnectDelayMs?: number;
    readonly reconnectFailures?: number;
    readonly reconnectUnavailable?: boolean;
}

export function createTuiConnectionErrorDependencies(
    options: TuiConnectionErrorOptions = {},
): TuiDependencies {
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

    if (options.reconnectUnavailable === true) {
        return { client };
    }

    let remainingFailures = options.reconnectFailures ?? 0;
    return {
        client,
        reconnectSession: async () => {
            if (options.reconnectDelayMs !== undefined) {
                await delay(options.reconnectDelayMs);
            }
            if (remainingFailures > 0) {
                remainingFailures -= 1;
                throw new Error("could not start host");
            }
            return createReconnectedClient();
        },
    };
}

function createReconnectedClient(): TuiAgentClient {
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
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

if (import.meta.main) {
    installTestProcessGuard();
    await startTui(createTuiConnectionErrorDependencies());
}
