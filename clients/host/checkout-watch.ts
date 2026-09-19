import { existsSync } from "node:fs";

import type { ShutdownSignalWait } from "./process-lifecycle.ts";

export const CHECKOUT_POLL_MS = 30_000;

export interface CheckoutWatchOptions {
    readonly intervalMs?: number;
    readonly exists?: (path: string) => boolean;
}

/**
 * Resolves once the host's own source file is gone. A host from a deleted
 * worktree keeps running with no socket anyone will find again.
 */
export function waitForCheckoutRemoval(
    source: string,
    options: CheckoutWatchOptions = {},
): ShutdownSignalWait {
    const exists = options.exists ?? existsSync;
    let dispose = (): void => {};
    const promise = new Promise<void>((resolve) => {
        const timer = setInterval(() => {
            if (exists(source)) return;
            dispose();
            resolve();
        }, options.intervalMs ?? CHECKOUT_POLL_MS);
        // The timer alone must not keep an otherwise finished process alive.
        timer.unref();
        dispose = () => clearInterval(timer);
    });
    return { promise, dispose };
}
