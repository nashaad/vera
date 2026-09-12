import { join } from "node:path";

import {
    startTui,
    type TuiAgentClient,
    type TuiDependencies,
    type TuiExit,
} from "../../clients/tui/main.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";

export interface TuiTrashSessionScenario {
    readonly dependencies: TuiDependencies;
    finish(exit: TuiExit): Promise<void>;
}

export function createTuiTrashSessionScenario(options: {
    readonly home: string;
    readonly trashBusy?: boolean;
}): TuiTrashSessionScenario {
    let trashed = "";
    let listCalls = 0;
    const sessions = [{
        id: "saved-session",
        workspace: "/work/vera",
        session_path: "/sessions/saved.jsonl",
        kind: "interactive" as const,
        status: "idle" as const,
        live: false,
        title: "Continue the theme picker",
        updated_at: "2026-07-20T20:00:00.000Z",
    }];
    const client: TuiAgentClient = {
        agentId: "current-session",
        async send(): Promise<void> {},
        receive(): Promise<never> {
            return new Promise(() => {});
        },
        async detach(): Promise<void> {},
        close(): void {},
    };

    return {
        dependencies: {
            client,
            listAgents: async () => {
                listCalls += 1;
                if (listCalls > 1) {
                    await Bun.sleep(300);
                }
                return [...sessions];
            },
            trashSession: async (sessionId) => {
                if (options.trashBusy === true) {
                    return { status: "rejected", reason: "busy" };
                }
                const index = sessions.findIndex((session) =>
                    session.id === sessionId
                );
                if (index === -1) {
                    return { status: "rejected", reason: "not_found" };
                }
                sessions.splice(index, 1);
                trashed = sessionId;
                return { status: "trashed" };
            },
        },
        async finish() {
            await Bun.write(
                join(options.home, "trash-session-result.txt"),
                trashed,
            );
        },
    };
}

if (import.meta.main) {
    installTestProcessGuard();
    const scenario = createTuiTrashSessionScenario({
        home: process.env.HOME ?? ".",
        trashBusy: process.env.TRASH_BUSY === "1",
    });
    await scenario.finish(await startTui(scenario.dependencies));
}
