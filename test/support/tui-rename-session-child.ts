import { join } from "node:path";

import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AgentUpdate, ClientCommand } from "../../src/engine/protocol.ts";
import {
    startTui,
    type TuiAgentClient,
    type TuiDependencies,
    type TuiExit,
} from "../../clients/tui/main.ts";

export interface TuiRenameSessionScenario {
    readonly dependencies: TuiDependencies;
    finish(exit: TuiExit): Promise<void>;
}

export function createTuiRenameSessionScenario(options: {
    readonly home: string;
    readonly renameBusy?: boolean;
}): TuiRenameSessionScenario {
    let savedName = "Continue the theme picker";
    let currentName = "Fix the deployment race";
    const hostCalls: string[] = [];
    const updates = new AsyncQueue<AgentUpdate>();

    const client: TuiAgentClient = {
        agentId: "current-session",
        async send(command: ClientCommand): Promise<void> {
            if (command.type === "update_session_name") {
                currentName = command.name ?? "Fix the deployment race";
                updates.push({
                    type: "session_name",
                    requestId: command.requestId,
                    name: command.name,
                });
            }
        },
        receive(signal) {
            return updates.receive(signal);
        },
        async detach(): Promise<void> {},
        close(): void {},
    };

    return {
        dependencies: {
            client,
            listAgents: async () => [
                {
                    id: "saved-session",
                    workspace: "/work/vera",
                    session_path: "/sessions/saved.jsonl",
                    kind: "interactive" as const,
                    status: "idle" as const,
                    live: false,
                    title: savedName,
                    updated_at: "2026-07-20T20:00:00.000Z",
                },
                {
                    id: "current-session",
                    workspace: "/work/vera",
                    session_path: "/sessions/current.jsonl",
                    kind: "interactive" as const,
                    status: "idle" as const,
                    live: false,
                    title: currentName,
                    updated_at: "2026-07-20T19:00:00.000Z",
                },
            ],
            renameSession: async (sessionId, requestedName) => {
                hostCalls.push(`${sessionId} ${requestedName ?? "(cleared)"}`);
                if (options.renameBusy === true) {
                    return { status: "rejected", reason: "busy" };
                }
                savedName = requestedName ?? "Continue the theme picker";
                return { status: "renamed", name: requestedName };
            },
        },
        async finish() {
            await Bun.write(
                join(options.home, "rename-session-result.txt"),
                `${hostCalls.join("\n")}\ncurrent ${currentName}`,
            );
        },
    };
}

if (import.meta.main) {
    const scenario = createTuiRenameSessionScenario({
        home: process.env.HOME ?? ".",
        renameBusy: process.env.RENAME_BUSY === "1",
    });
    await scenario.finish(await startTui(scenario.dependencies));
}
