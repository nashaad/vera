import { join } from "node:path";

import {
    startTui,
    type TuiDependencies,
    type TuiExit,
} from "../../clients/tui/main.ts";
import { createSettingsAnsweringClient } from "./settings-answering-client.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";
import {
    HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE,
} from "../../src/host/capabilities.ts";

export interface TuiNewSessionScenario {
    readonly dependencies: TuiDependencies;
    finish(exit: TuiExit): Promise<void>;
}

export function createTuiNewSessionScenario(options: {
    readonly home: string;
    readonly createTimeout?: boolean;
    readonly closeFailure?: boolean;
    readonly otherInteractiveAttachments?: number;
}): TuiNewSessionScenario {
    let detached = false;
    let nextDetached = false;
    let createAttempts = 0;
    let createdForWorkspace = "none";
    const closedAgentIds: string[] = [];
    const client = createSettingsAnsweringClient({
        agentId: "current-session-id",
        workspace: "/work/vera",
        model: "current-model",
        mode: "review",
        onDetach: () => {
            detached = true;
        },
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

    return {
        dependencies: {
            client,
            ...(options.createTimeout === true
                ? { sessionSwitchTimeoutMs: 100 }
                : {}),
            createSession: async (workspace) => {
                createAttempts += 1;
                createdForWorkspace = workspace;
                if (options.createTimeout === true) {
                    return new Promise(() => {});
                }
                if (createAttempts === 1) {
                    throw new Error("host refused creation");
                }
                await Bun.sleep(400);
                return createSettingsAnsweringClient({
                    agentId: "new-session-id",
                    workspace,
                    model: "fresh-model",
                    mode: "full_access",
                    initialUpdates: [{
                        type: "history",
                        entries: [],
                        seq: 0,
                    }],
                    onDetach: () => {
                        nextDetached = true;
                    },
                });
            },
            closeSession: async (agentId) => {
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
                join(options.home, "new-session-result.txt"),
                [
                    // The session attached at exit, which is the new one: the
                    // TUI switched to it in place rather than closing and
                    // asking to be started again.
                    exit.agentId ?? "none",
                    detached ? "detached" : "attached",
                    nextDetached ? "next detached" : "next attached",
                    `attempts ${createAttempts}`,
                    createdForWorkspace,
                    `closed ${closedAgentIds.join(",")}`,
                ].join("\n"),
            );
        },
    };
}

if (import.meta.main) {
    installTestProcessGuard();
    const scenario = createTuiNewSessionScenario({
        home: process.env.HOME ?? ".",
        createTimeout: process.env.CREATE_TIMEOUT === "1",
    });
    await scenario.finish(await startTui(scenario.dependencies));
}
