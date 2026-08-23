import {
    startTui,
    type TuiAgentClient,
    type TuiDependencies,
} from "../../clients/tui/main.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AgentUpdate, ClientCommand } from "../../src/engine/protocol.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";

export function createTuiInboxNoticeDependencies(): TuiDependencies {
    const updates = new AsyncQueue<AgentUpdate>();
    updates.push({ type: "history", entries: [], seq: 0 });
    updates.push({ type: "notice", key: "inbox", count: 1, seq: 1 });
    updates.push({ type: "notice", key: "inbox", count: 2, seq: 2 });

    const client: TuiAgentClient = {
        async send(_command: ClientCommand): Promise<void> {},
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
    await startTui(createTuiInboxNoticeDependencies());
}
