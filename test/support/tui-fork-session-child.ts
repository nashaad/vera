import { join } from "node:path";

import {
    startTui,
    type TuiDependencies,
    type TuiExit,
} from "../../clients/tui/main.ts";
import { createSettingsAnsweringClient } from "./settings-answering-client.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";

export interface TuiForkSessionScenario {
    readonly dependencies: TuiDependencies;
    finish(exit: TuiExit): Promise<void>;
}

export function createTuiForkSessionScenario(options: {
    readonly home: string;
    readonly forkTimeout?: "timeout" | "hold";
}): TuiForkSessionScenario {
    let detached = false;
    let forkBoundary = "";
    let forkedFrom = "none";

    const client = createSettingsAnsweringClient({
        agentId: "source-session",
        model: "source-model",
        mode: "review",
        onCommand: (command, push) => {
            if (command.type !== "list_timeline") return;
            push({
                type: "timeline",
                requestId: command.requestId,
                boundaries: [{
                    userMessageId: "prompt-1",
                    timestamp: "2026-07-23T12:00:00.000Z",
                    prompt: "edit this prompt",
                    position: 0,
                    attachments: [{ id: "image-1" }],
                }],
            });
        },
        onDetach: () => {
            detached = true;
        },
    });

    return {
        dependencies: {
            client,
            forkSession: async (agentId, boundaryId) => {
                forkedFrom = agentId;
                forkBoundary = boundaryId;
                if (options.forkTimeout !== undefined) {
                    return new Promise(() => {});
                }
                await Bun.sleep(300);
                return {
                    client: createSettingsAnsweringClient({
                        agentId: "forked-session",
                        model: "forked-model",
                        mode: "full_access",
                    }),
                    prompt: {
                        role: "user",
                        content: [
                            { type: "text", text: "edit this prompt" },
                            {
                                type: "image_attachment",
                                attachmentId: "image-1",
                            },
                        ],
                    },
                };
            },
            ...(options.forkTimeout === "timeout"
                ? { sessionSwitchTimeoutMs: 100 }
                // "hold" keeps the switch pending for the whole test, which is
                // the only way to press ctrl+c while one is in flight.
                : options.forkTimeout === "hold"
                ? { sessionSwitchTimeoutMs: 60_000 }
                : {}),
        },
        async finish(exit) {
            await Bun.write(
                join(options.home, "fork-session-result.txt"),
                JSON.stringify({
                    agentId: exit.agentId,
                    detached,
                    forkBoundary,
                    forkedFrom,
                }),
            );
        },
    };
}

if (import.meta.main) {
    installTestProcessGuard();
    const scenario = createTuiForkSessionScenario({
        home: process.env.HOME ?? ".",
        ...(process.env.FORK_TIMEOUT === "1"
            ? { forkTimeout: "timeout" as const }
            : process.env.FORK_TIMEOUT === "hold"
            ? { forkTimeout: "hold" as const }
            : {}),
    });
    await scenario.finish(await startTui(scenario.dependencies));
}
