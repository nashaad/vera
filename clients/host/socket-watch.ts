import { statSync } from "node:fs";

import type { ShutdownSignalWait } from "./process-lifecycle.ts";

export const SOCKET_POLL_MS = 30_000;

export interface SocketWatchOptions {
    readonly intervalMs?: number;
    // Returns "dev:ino" for the path, or throws like statSync.
    readonly identify?: (path: string) => string;
}

/**
 * Resolves once the host's socket file is gone or is a different file. No
 * client can reach this host again, and another host may already serve the
 * same home.
 */
export function waitForSocketLoss(
    socketPath: string,
    options: SocketWatchOptions = {},
): ShutdownSignalWait {
    const identify = options.identify ?? fileIdentity;
    let bound = readIdentity(socketPath, identify);
    let dispose = (): void => {};
    const promise = new Promise<void>((resolve) => {
        const timer = setInterval(() => {
            const current = readIdentity(socketPath, identify);
            if (current.kind === "unknown") return;
            if (bound.kind === "unknown") {
                bound = current;
            }
            if (current.kind === "present" && bound.kind === "present"
                && current.identity === bound.identity) {
                return;
            }
            dispose();
            resolve();
        }, options.intervalMs ?? SOCKET_POLL_MS);
        // The timer alone must not keep an otherwise finished process alive.
        timer.unref();
        dispose = () => clearInterval(timer);
    });
    return { promise, dispose };
}

type SocketIdentity =
    | { readonly kind: "present"; readonly identity: string }
    | { readonly kind: "missing" }
    | { readonly kind: "unknown" };

function readIdentity(
    socketPath: string,
    identify: (path: string) => string,
): SocketIdentity {
    try {
        return { kind: "present", identity: identify(socketPath) };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Any other failure may be transient, so it never stops the host.
        if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
        return { kind: "unknown" };
    }
}

function fileIdentity(path: string): string {
    const stats = statSync(path, { bigint: true });
    return `${stats.dev}:${stats.ino}`;
}
