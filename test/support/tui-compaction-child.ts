import {
    startTui,
    type TuiAgentClient,
    type TuiDependencies,
} from "../../clients/tui/main.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";

/** A compaction that starts and never finishes, so the bar stays visible. */
export function createTuiCompactionDependencies(): TuiDependencies {
    const updates = new AsyncQueue<AgentUpdate>();
    updates.push({
        type: "compaction",
        phase: "started",
        strategy: "vera/full-summary",
        seq: 0,
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
    installTestProcessGuard();
    await startTui(createTuiCompactionDependencies());
}
