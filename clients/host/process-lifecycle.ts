import { createHostLogger, type HostLog } from "../../src/host/host-log.ts";
import type { ResidentHost } from "../../src/host/runtime.ts";

// Keep under the SIGTERM grace in src/host/force-stop.ts, or an upgrade reports this host as still running.
export const HOST_CLOSE_DEADLINE_MS = 2_500;

export interface ShutdownSignalWait {
    readonly promise: Promise<void>;
    dispose(): void;
}

export interface ResidentHostProcessOptions {
    readonly waitForSignal?: () => ShutdownSignalWait;
    readonly waitForCheckoutRemoval?: () => ShutdownSignalWait;
    readonly exit?: (code: number) => void;
    readonly stopAbsorbingFaults?: () => void;
    readonly closeDeadlineMs?: number;
    readonly log?: HostLog;
}

type CloseableResidentHost = Pick<ResidentHost, "shutdownRequested" | "close">;

type CloseOutcome =
    | { readonly kind: "closed" }
    | { readonly kind: "failed"; readonly error: unknown }
    | { readonly kind: "timed_out" };

export async function runResidentHostProcess(
    host: CloseableResidentHost,
    options: ResidentHostProcessOptions = {},
): Promise<void> {
    const exit = options.exit ?? ((code) => process.exit(code));
    const signal = (options.waitForSignal ?? waitForShutdownSignal)();
    const checkout = options.waitForCheckoutRemoval?.();
    try {
        await Promise.race([
            signal.promise,
            host.shutdownRequested,
            ...(checkout === undefined ? [] : [checkout.promise]),
        ]);
    } finally {
        signal.dispose();
        checkout?.dispose();
        options.stopAbsorbingFaults?.();
        const deadlineMs = options.closeDeadlineMs ?? HOST_CLOSE_DEADLINE_MS;
        const outcome = await closeBeforeDeadline(host, deadlineMs);
        if (outcome.kind === "failed") {
            process.stderr.write(
                `Resident Vera host failed to close: ${
                    outcome.error instanceof Error
                        ? outcome.error.message
                        : String(outcome.error)
                }\n`,
            );
            exit(1);
        } else if (outcome.kind === "timed_out") {
            // A stuck turn or extension must not keep a host alive that was told to stop.
            const message = `Resident Vera host did not finish closing within ${deadlineMs} ms; exiting anyway.`;
            process.stderr.write(`${message}\n`);
            (options.log ?? createHostLogger())({
                type: "host_close_timed_out",
                deadline_ms: deadlineMs,
                error: message,
            });
        }
    }

    exit(0);
}

async function closeBeforeDeadline(
    host: CloseableResidentHost,
    deadlineMs: number,
): Promise<CloseOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<CloseOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timed_out" }), deadlineMs);
    });
    const closing = host.close().then(
        (): CloseOutcome => ({ kind: "closed" }),
        (error: unknown): CloseOutcome => ({ kind: "failed", error }),
    );
    try {
        return await Promise.race([closing, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

function waitForShutdownSignal(): ShutdownSignalWait {
    let dispose = (): void => {};
    const promise = new Promise<void>((resolve) => {
        const stop = (): void => {
            dispose();
            resolve();
        };
        dispose = () => {
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
    });
    return { promise, dispose };
}
