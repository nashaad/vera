import { join } from "node:path";

import {
    startTui,
    type TuiDependencies,
    type TuiExit,
} from "../../clients/tui/main.ts";
import { createSettingsAnsweringClient } from "./settings-answering-client.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";

export interface TuiResumeScenario {
    readonly dependencies: TuiDependencies;
    finish(exit: TuiExit): Promise<void>;
}

export function createTuiResumeScenario(options: {
    readonly home: string;
    readonly resumeTimeout?: boolean;
    readonly closeFailure?: boolean;
    readonly closeDelayMs?: number;
}): TuiResumeScenario {
    /**
     * The picker prints this as a relative age, so a fixed date would render
     * differently every day and the test asserts on that label. 90 minutes
     * floors to "1h ago" with plenty of slack for a slow start.
     */
    const updatedAt = new Date(Date.now() - 90 * 60_000).toISOString();

    let detached = false;
    let resumedPath = "none";
    const closedAgentIds: string[] = [];
    const firstClient = createSettingsAnsweringClient({
        agentId: "current-session-id",
        model: "current-model",
        mode: "review",
        onDetach: () => {
            detached = true;
        },
    });

    return {
        // One startTui call for the whole run. Switching sessions no longer
        // ends the TUI, so a second call here would be exercising a handover
        // that cannot happen.
        dependencies: {
            client: firstClient,
            listAgents: async () => [
                {
                    id: "current-session-id",
                    workspace: "/work/vera",
                    session_path: "/sessions/current.jsonl",
                    kind: "interactive",
                    status: "idle",
                    live: false,
                    title: "The one already open",
                    updated_at: new Date().toISOString(),
                },
                {
                    id: "target-session-id",
                    workspace: "/work/vera",
                    session_path: "/sessions/target.jsonl",
                    kind: "interactive",
                    status: "idle",
                    live: false,
                    title: "Continue the theme picker",
                    updated_at: updatedAt,
                },
                {
                    id: "empty-session-id",
                    workspace: "/work/vera",
                    session_path: "/sessions/empty.jsonl",
                    kind: "interactive",
                    status: "idle",
                    live: false,
                    updated_at: new Date().toISOString(),
                },
            ],
            ...(options.resumeTimeout === true
                ? { sessionSwitchTimeoutMs: 100 }
                : {}),
            resumeSession: async (sessionPath) => {
                resumedPath = sessionPath;
                if (options.resumeTimeout === true) {
                    return new Promise(() => {});
                }
                // The resumed session runs a different model in full access:
                // the status line has to report both as soon as the transcript
                // lands.
                return createSettingsAnsweringClient({
                    agentId: "target-session-id",
                    model: "resumed-model",
                    mode: "full_access",
                    initialUpdates: [{
                        type: "history",
                        entries: [{
                            kind: "assistant",
                            text: "RESUMED HISTORY LOADED",
                        }],
                        seq: 0,
                    }],
                });
            },
            closeSession: async (agentId) => {
                if (
                    agentId === "current-session-id"
                    && options.closeDelayMs !== undefined
                ) {
                    await Bun.sleep(options.closeDelayMs);
                }
                if (
                    options.closeFailure === true
                    && agentId === "current-session-id"
                ) {
                    return { status: "rejected", reason: "failed" };
                }
                closedAgentIds.push(agentId);
                return { status: "closed", sessionRetained: true };
            },
        },
        async finish(exit) {
            await Bun.write(
                join(options.home, "resume-result.txt"),
                [
                    resumedPath,
                    detached ? "detached" : "attached",
                    exit.agentId ?? "none",
                    `closed ${closedAgentIds.join(",")}`,
                ].join("\n"),
            );
        },
    };
}

if (import.meta.main) {
    installTestProcessGuard();
    const scenario = createTuiResumeScenario({
        home: process.env.HOME ?? ".",
        resumeTimeout: process.env.RESUME_TIMEOUT === "1",
    });
    await scenario.finish(await startTui(scenario.dependencies));
}
