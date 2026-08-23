import { join } from "node:path";

import {
    startTui,
    type TuiDependencies,
    type TuiExit,
} from "../../clients/tui/main.ts";
import { createSettingsAnsweringClient } from "./settings-answering-client.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";

export interface TuiCloneSessionScenario {
    readonly dependencies: TuiDependencies;
    finish(exit: TuiExit): Promise<void>;
}

export function createTuiCloneSessionScenario(options: {
    readonly home: string;
    readonly cloneTimeout?: boolean;
    /**
     * Holds the clone in flight until the test releases it, so an assertion
     * about the pending state never races a wall-clock delay.
     */
    readonly release?: Promise<void>;
}): TuiCloneSessionScenario {
    let detached = false;
    let cloneAttempts = 0;
    let clonedFrom = "none";
    const client = createSettingsAnsweringClient({
        agentId: "source-session",
        model: "source-model",
        mode: "review",
        onDetach: () => {
            detached = true;
        },
    });

    return {
        dependencies: {
            client,
            ...(options.cloneTimeout === true
                ? { sessionSwitchTimeoutMs: 100 }
                : {}),
            cloneSession: async (agentId) => {
                cloneAttempts += 1;
                clonedFrom = agentId;
                if (options.cloneTimeout === true) {
                    return new Promise(() => {});
                }
                if (options.release === undefined) {
                    await Bun.sleep(400);
                } else {
                    await options.release;
                }
                return createSettingsAnsweringClient({
                    agentId: "cloned-session",
                    model: "cloned-model",
                    mode: "full_access",
                });
            },
        },
        async finish(exit) {
            await Bun.write(
                join(options.home, "clone-session-result.txt"),
                [
                    exit.agentId ?? "none",
                    detached ? "detached" : "attached",
                    `attempts ${cloneAttempts}`,
                    clonedFrom,
                ].join("\n"),
            );
        },
    };
}

if (import.meta.main) {
    installTestProcessGuard();
    const scenario = createTuiCloneSessionScenario({
        home: process.env.HOME ?? ".",
        cloneTimeout: process.env.CLONE_TIMEOUT === "1",
    });
    await scenario.finish(await startTui(scenario.dependencies));
}
