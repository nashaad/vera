import { createHostLogger, type HostLog } from "../../src/host/host-log.ts";
import type { ResidentHost } from "../../src/host/runtime.ts";

// Keep under the SIGTERM grace in src/host/force-stop.ts, or an upgrade reports this host as still running.
export const HOST_CLOSE_DEADLINE_MS = 2_500;
// Covers both hand-off attempts in src/release/handoff.ts, so the process always exits.
export const AFTER_CLOSE_DEADLINE_MS = 75_000;

export interface ShutdownSignalWait {
    readonly promise: Promise<void>;
    dispose(): void;
}

export interface ResidentHostProcessOptions {
    readonly waitForSignal?: () => ShutdownSignalWait;
    readonly waitForCheckoutRemoval?: () => ShutdownSignalWait;
    readonly waitForSocketLoss?: () => ShutdownSignalWait;
    readonly exit?: (code: number) => void;
    readonly stopAbsorbingFaults?: () => void;
    readonly closeDeadlineMs?: number;
    readonly poolWorkerPids?: () => readonly number[];
    readonly log?: HostLog;
    // Runs after a failed or clean close and before exit. A timed-out close skips it, since that host may still serve.
    readonly afterClose?: () => Promise<void>;
    readonly afterCloseDeadlineMs?: number;
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
    const socket = options.waitForSocketLoss?.();
    let exitCode = 0;
    try {
        await Promise.race([
            signal.promise,
            host.shutdownRequested,
            ...(checkout === undefined ? [] : [checkout.promise]),
            ...(socket === undefined ? [] : [socket.promise]),
        ]);
    } finally {
        signal.dispose();
        checkout?.dispose();
        socket?.dispose();
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
            exitCode = 1;
        } else if (outcome.kind === "timed_out") {
            const pids = options.poolWorkerPids?.();
            const message = pids === undefined || pids.length === 0
                ? `Resident Vera host did not finish closing within ${deadlineMs} ms; exiting anyway.`
                : pids.map((pid) => `Could not confirm session process PID ${pid} stopped.`).join(" ");
            process.stderr.write(`${message}\n`);
            if (pids !== undefined) exitCode = 1;
            (options.log ?? createHostLogger())({
                type: "host_close_timed_out",
                deadline_ms: deadlineMs,
                error: message,
            });
        }
        // A failed close has already stopped the socket, so the hand-off cannot start a second host on it.
        if (outcome.kind !== "timed_out"
            && (outcome.kind !== "failed" || options.poolWorkerPids === undefined)
            && options.afterClose !== undefined) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const afterCloseMs = options.afterCloseDeadlineMs ?? AFTER_CLOSE_DEADLINE_MS;
            try {
                await Promise.race([
                    options.afterClose(),
                    new Promise<never>((_resolve, reject) => {
                        timer = setTimeout(() => reject(new Error(
                            `The update hand-off did not finish within ${afterCloseMs} ms; exiting so the next vera can start a host.`,
                        )), afterCloseMs);
                    }),
                ]);
            } catch (error) {
                process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
            } finally {
                clearTimeout(timer);
            }
        }
    }

    exit(exitCode);
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
