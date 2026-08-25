import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
    startTui,
    type TuiDependencies,
    type TuiExit,
} from "../../clients/tui/main.ts";
import { emptyUsage } from "../../src/model/types.ts";
import { createSettingsAnsweringClient } from "./settings-answering-client.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";
import {
    HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE,
} from "../../src/host/capabilities.ts";

/** Painted when an idle row opens as a file rather than a worker. */
export const IDLE_TARGET_TRANSCRIPT = "SAVED TRANSCRIPT LOADED";

export interface TuiResumeScenario {
    readonly dependencies: TuiDependencies;
    readonly targetPath: string;
    finish(exit: TuiExit): Promise<void>;
}

export function createTuiResumeScenario(options: {
    readonly home: string;
    readonly resumeTimeout?: boolean;
    readonly closeFailure?: boolean;
    readonly closeDelayMs?: number;
    readonly otherInteractiveAttachments?: number;
    /**
     * Treat the target as already running so open attaches instead of
     * painting the session file. Timeout tests hang inside resume.
     */
    readonly targetLive?: boolean;
    /**
     * Replay the current session as still working so close asks first.
     */
    readonly inFlight?: boolean;
}): TuiResumeScenario {
    /**
     * The picker prints this as a relative age, so a fixed date would render
     * differently every day and the test asserts on that label. 90 minutes
     * floors to "1h ago" with plenty of slack for a slow start.
     */
    const updatedAt = new Date(Date.now() - 90 * 60_000).toISOString();
    const sessionsDir = join(options.home, "sessions");
    const currentPath = join(sessionsDir, "current.jsonl");
    const targetPath = join(sessionsDir, "target.jsonl");
    const emptyPath = join(sessionsDir, "empty.jsonl");
    writeIdleSessionFile(currentPath, "current-session-id", "current on disk");
    writeIdleSessionFile(
        targetPath,
        "target-session-id",
        IDLE_TARGET_TRANSCRIPT,
    );
    writeIdleSessionFile(emptyPath, "empty-session-id");

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
        ...(options.inFlight === true
            ? {
                initialUpdates: [{
                    type: "history" as const,
                    entries: [{
                        kind: "assistant" as const,
                        text: "TURN IN FLIGHT",
                    }],
                    status: "working" as const,
                    seq: 0,
                }],
            }
            : {}),
        ...(options.otherInteractiveAttachments === undefined ? {} : {
            supportsHostCapability: (capability: string) =>
                capability === HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE,
            release: async () => ({
                outcome: "detached" as const,
                remainingInteractiveClients:
                    options.otherInteractiveAttachments ?? 0,
            }),
        }),
    });
    const targetLive = options.targetLive === true
        || options.resumeTimeout === true;

    return {
        targetPath,
        // One startTui call for the whole run. Switching sessions no longer
        // ends the TUI, so a second call here would be exercising a handover
        // that cannot happen.
        dependencies: {
            client: firstClient,
            listAgents: async () => [
                {
                    id: "current-session-id",
                    workspace: "/work/vera",
                    session_path: currentPath,
                    kind: "interactive",
                    status: "idle",
                    live: false,
                    has_user_content: true,
                    title: "The one already open",
                    updated_at: new Date().toISOString(),
                },
                {
                    id: "target-session-id",
                    workspace: "/work/vera",
                    session_path: targetPath,
                    kind: "interactive",
                    status: targetLive ? "working" : "idle",
                    live: targetLive,
                    has_user_content: true,
                    ...(targetLive ? { worker_pid: 4242 } : {}),
                    title: "Continue the theme picker",
                    updated_at: updatedAt,
                },
                {
                    id: "empty-session-id",
                    workspace: "/work/vera",
                    session_path: emptyPath,
                    kind: "interactive",
                    status: "idle",
                    live: false,
                    has_user_content: false,
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

function writeIdleSessionFile(
    path: string,
    sessionId: string,
    assistantText?: string,
): void {
    mkdirSync(dirname(path), { recursive: true });
    const timestamp = "2026-08-22T11:00:00.000Z";
    const lines = [
        JSON.stringify({
            type: "session",
            version: 1,
            id: sessionId,
            timestamp,
            cwd: "/work/vera",
        }),
    ];
    if (assistantText !== undefined) {
        const userId = `${sessionId}-user`;
        const assistantId = `${sessionId}-assistant`;
        lines.push(JSON.stringify({
            type: "message",
            id: userId,
            parentId: null,
            timestamp,
            message: {
                role: "user",
                content: [{ type: "text", text: "hello from disk" }],
            },
        }));
        lines.push(JSON.stringify({
            type: "message",
            id: assistantId,
            parentId: userId,
            timestamp,
            message: {
                role: "assistant",
                content: [{ type: "text", text: assistantText }],
                source: { provider: "faux", api: "scripted", model: "test" },
                usage: emptyUsage(),
                stopReason: "stop",
            },
        }));
    }
    writeFileSync(path, `${lines.join("\n")}\n`);
}

if (import.meta.main) {
    installTestProcessGuard();
    const scenario = createTuiResumeScenario({
        home: process.env.VERA_TUI_TEST_HOME ?? process.env.HOME ?? ".",
        resumeTimeout: process.env.RESUME_TIMEOUT === "1",
        ...(process.env.OTHER_INTERACTIVE_ATTACHMENTS === undefined
            ? {}
            : {
                otherInteractiveAttachments: Number.parseInt(
                    process.env.OTHER_INTERACTIVE_ATTACHMENTS,
                    10,
                ),
            }),
    });
    await scenario.finish(await startTui(scenario.dependencies));
}
