import { createHostLogger, type HostLog } from "../../src/host/host-log.ts";
import type { HostIdentity } from "../../src/host/protocol.ts";
import type { ResidentHost } from "../../src/host/runtime.ts";

// Keep under the SIGTERM grace in src/host/force-stop.ts, or an upgrade reports this host as still running.
export const HOST_CLOSE_DEADLINE_MS = 2_500;
// Covers both hand-off attempts in src/release/handoff.ts, so the process always exits.
export const AFTER_CLOSE_DEADLINE_MS = 75_000;

export type HostShutdownSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

export interface ShutdownSignalWait<T = void> {
    readonly promise: Promise<T>;
    dispose(): void;
}

export interface ResidentHostProcessOptions {
    readonly waitForSignal?: () => ShutdownSignalWait<void | HostShutdownSignal>;
    readonly waitForCheckoutRemoval?: () => ShutdownSignalWait;
    readonly waitForSocketLoss?: () => ShutdownSignalWait;
    readonly exit?: (code: number) => void;
    readonly stopAbsorbingFaults?: () => void;
    readonly closeDeadlineMs?: number;
    readonly poolWorkerPids?: () => readonly number[];
    readonly log?: HostLog;
    readonly identity?: Pick<HostIdentity, "pid" | "started_at" | "build_id">;
    // Runs after a failed or clean close and before exit. A timed-out close skips it, since that host may still serve.
    readonly afterClose?: () => Promise<void>;
    readonly afterCloseDeadlineMs?: number;
}

export function installStartupSignalLogging(log: HostLog, identity: Pick<HostIdentity, "pid" | "started_at" | "build_id">): () => void {
    const stop = (signal: HostShutdownSignal): void => {
        dispose();
        log({ type: "host_stopping", role: "host", ...identity, reason: "signal", signal });
        process.kill(process.pid, signal);
    };
    const onInterrupt = (): void => stop("SIGINT");
    const onTerminate = (): void => stop("SIGTERM");
    const onHangup = (): void => stop("SIGHUP");
    const dispose = (): void => {
        process.off("SIGINT", onInterrupt);
        process.off("SIGTERM", onTerminate);
        process.off("SIGHUP", onHangup);
    };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    process.once("SIGHUP", onHangup);
    return dispose;
}

type CloseableResidentHost = Pick<ResidentHost, "shutdownRequested" | "close" | "shutdownCause">;

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
        const cause = await Promise.race([
            signal.promise.then((name) => ({ reason: "signal", ...(name === undefined ? {} : { signal: name }) })),
            host.shutdownRequested.then(() => host.shutdownCause?.() ?? { reason: "shutdown_requested" }),
            ...(checkout === undefined ? [] : [checkout.promise.then(() => ({ reason: "checkout_removed" }))]),
            ...(socket === undefined ? [] : [socket.promise.then(() => ({ reason: "socket_lost" }))]),
        ]);
        (options.log ?? createHostLogger())({
            type: "host_stopping",
            ...(options.identity === undefined ? { pid: process.pid } : { role: "host", ...options.identity }),
            ...cause,
        });
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

function waitForShutdownSignal(): ShutdownSignalWait<HostShutdownSignal> {
    let dispose = (): void => {};
    const promise = new Promise<HostShutdownSignal>((resolve) => {
        const stop = (name: HostShutdownSignal): void => {
            dispose();
            resolve(name);
        };
        const onInterrupt = (): void => stop("SIGINT");
        const onTerminate = (): void => stop("SIGTERM");
        const onHangup = (): void => stop("SIGHUP");
        dispose = () => {
            process.off("SIGINT", onInterrupt);
            process.off("SIGTERM", onTerminate);
            process.off("SIGHUP", onHangup);
        };
        process.once("SIGINT", onInterrupt);
        process.once("SIGTERM", onTerminate);
        process.once("SIGHUP", onHangup);
    });
    return { promise, dispose };
}
