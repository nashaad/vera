import { mkdirSync, watch } from "node:fs";

import {
    blockedSessionMessage,
    isSessionBlockedSync,
} from "./session-block.ts";

export interface SessionBlockLatchOptions {
    readonly directory: string;
    readonly sessionId: string;
    readonly onLatched: (reason: string) => void;
    readonly onReleased: () => void;
}

export interface SessionBlockLatch {
    // Returns the reason once the flag has been seen. The latch stays set until release.
    check(): string | undefined;
    release(): void;
    close(): void;
}

// The watcher is an early signal only; check() is the source of truth, so a missed event costs one step at most.
export function createSessionBlockLatch(
    options: SessionBlockLatchOptions,
): SessionBlockLatch {
    let latched: string | undefined;
    mkdirSync(options.directory, { recursive: true });

    function check(): string | undefined {
        if (latched !== undefined) return latched;
        if (!isSessionBlockedSync(options.directory, options.sessionId)) {
            return undefined;
        }
        latched = blockedSessionMessage(options.sessionId);
        options.onLatched(latched);
        return latched;
    }

    const watcher = watch(options.directory, () => {
        check();
    });
    watcher.on("error", () => {});

    return {
        check,
        release(): void {
            if (latched === undefined) return;
            latched = undefined;
            options.onReleased();
        },
        close(): void {
            watcher.close();
        },
    };
}
