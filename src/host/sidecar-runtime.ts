import {
    chmodSync,
    closeSync,
    fchmodSync,
    mkdirSync,
    openSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { OwnedSidecarContribution } from "../extensions/contribution-set.ts";

/**
 * One supervised child process per contributed sidecar. The extension
 * contributed inert data; the host owns the process, the restarts, and the
 * log. Supervision is per sidecar: one that crash-loops never reaches
 * another, and stopping the host stops them all.
 *
 * Restart versus quarantine mirrors the watch supervisor: anything a retry
 * could fix backs off and retries; a sidecar that keeps dying stops and waits
 * for the user, because a restart loop against a broken command only hides
 * the breakage.
 */

export const SIDECAR_BASE_BACKOFF_MS = 1_000;
export const SIDECAR_MAX_BACKOFF_MS = 60_000;
/** How long a run must last before the backoff ladder resets. */
export const SIDECAR_HEALTHY_RUN_MS = 60_000;
export const SIDECAR_FAILURE_WINDOW_MS = 5 * 60_000;
export const SIDECAR_FAILURES_BEFORE_QUARANTINE = 5;
/** How long a stop waits between SIGTERM and SIGKILL. */
export const SIDECAR_STOP_GRACE_MS = 5_000;

export type SidecarState =
    | "starting"
    | "running"
    | "backoff"
    | "quarantined"
    | "stopped";

export interface SidecarStatus {
    readonly sidecarId: string;
    readonly extensionId: string;
    readonly state: SidecarState;
    readonly pid: number | null;
    readonly failures: number;
    readonly lastError: string | null;
    readonly nextRetryInMs: number | null;
    readonly logPath: string;
}

interface SidecarTiming {
    readonly baseBackoffMs: number;
    readonly maxBackoffMs: number;
    readonly healthyRunMs: number;
    readonly failureWindowMs: number;
    readonly failuresBeforeQuarantine: number;
    readonly stopGraceMs: number;
}

const DEFAULT_TIMING: SidecarTiming = {
    baseBackoffMs: SIDECAR_BASE_BACKOFF_MS,
    maxBackoffMs: SIDECAR_MAX_BACKOFF_MS,
    healthyRunMs: SIDECAR_HEALTHY_RUN_MS,
    failureWindowMs: SIDECAR_FAILURE_WINDOW_MS,
    failuresBeforeQuarantine: SIDECAR_FAILURES_BEFORE_QUARANTINE,
    stopGraceMs: SIDECAR_STOP_GRACE_MS,
};

export interface SupervisedSidecarOptions {
    readonly sidecar: OwnedSidecarContribution;
    /** Passed to the child as VERA_SOCKET. */
    readonly socketPath: string;
    readonly logPath: string;
    readonly timing?: Partial<SidecarTiming>;
    readonly now?: () => number;
    readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    readonly random?: () => number;
    readonly onStateChange?: (status: SidecarStatus) => void;
}

export class SupervisedSidecar {
    readonly sidecarId: string;

    private readonly sidecar: OwnedSidecarContribution;
    private readonly socketPath: string;
    private readonly logPath: string;
    private readonly timing: SidecarTiming;
    private readonly clock: () => number;
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
    private readonly random: () => number;
    private readonly onStateChange: (status: SidecarStatus) => void;

    private controller: AbortController | null = null;
    private loop: Promise<void> | null = null;
    private child: Bun.Subprocess | null = null;
    private stopping = false;
    private state: SidecarState = "stopped";
    private consecutiveFailures = 0;
    private failureTimes: number[] = [];
    private lastError: string | null = null;
    private nextRetryInMs: number | null = null;

    constructor(options: SupervisedSidecarOptions) {
        this.sidecar = options.sidecar;
        this.sidecarId = options.sidecar.id;
        this.socketPath = options.socketPath;
        this.logPath = options.logPath;
        this.timing = { ...DEFAULT_TIMING, ...options.timing };
        this.clock = options.now ?? (() => Date.now());
        this.sleep = options.sleep ?? defaultSleep;
        this.random = options.random ?? Math.random;
        this.onStateChange = options.onStateChange ?? ((): void => undefined);
    }

    status(): SidecarStatus {
        return {
            sidecarId: this.sidecarId,
            extensionId: this.sidecar.extensionId,
            state: this.state,
            pid: this.child?.pid ?? null,
            failures: this.consecutiveFailures,
            lastError: this.lastError,
            nextRetryInMs: this.nextRetryInMs,
            logPath: this.logPath,
        };
    }

    start(): void {
        if (this.loop !== null) {
            return;
        }
        this.stopping = false;
        this.controller = new AbortController();
        this.loop = this.supervise(this.controller.signal);
    }

    /**
     * Stops the child and waits for it to exit. The intent is recorded before
     * any signal is sent, so a host-initiated stop is never logged as a
     * crash. SIGTERM first, a bounded grace, then SIGKILL.
     */
    async stop(): Promise<void> {
        this.stopping = true;
        this.controller?.abort();
        const loop = this.loop;
        this.loop = null;
        this.controller = null;
        const child = this.child;
        if (child !== null && child.exitCode === null) {
            child.kill("SIGTERM");
            const grace = new AbortController();
            await Promise.race([
                child.exited,
                this.sleep(this.timing.stopGraceMs, grace.signal),
            ]);
            grace.abort();
            if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGKILL");
                await child.exited.catch(() => undefined);
            }
        }
        if (loop !== null) {
            await loop.catch(() => undefined);
        }
        this.enter("stopped");
    }

    /**
     * Wrapped whole. An unhandled rejection here would kill the task while
     * `status()` still reported the last state it reached.
     */
    private async supervise(signal: AbortSignal): Promise<void> {
        try {
            await this.superviseLoop(signal);
        } catch (error) {
            this.lastError = errorMessage(error);
            this.enterUnconditionally("quarantined");
        }
    }

    private async superviseLoop(signal: AbortSignal): Promise<void> {
        while (!signal.aborted) {
            this.enter("starting");
            const startedAt = this.clock();
            const outcome = await this.runChild(signal);
            this.child = null;
            if (signal.aborted || this.stopping) {
                return;
            }
            if (!this.sidecar.definition.restart) {
                if (outcome === null) {
                    this.enter("stopped");
                } else {
                    this.lastError = outcome;
                    this.enter("quarantined");
                }
                return;
            }
            this.noteFailure(
                outcome ?? "sidecar exited cleanly before it was stopped",
            );

            if (this.ranLongEnough(startedAt)) {
                this.resetFailureLadder();
            }
            if (this.shouldQuarantine()) {
                this.enter("quarantined");
                return;
            }
            const delay = this.backoffMs();
            this.nextRetryInMs = delay;
            this.enter("backoff");
            await this.sleep(delay, signal);
            this.nextRetryInMs = null;
        }
    }

    /** Returns null on a clean exit, otherwise a failure description. */
    private async runChild(signal: AbortSignal): Promise<string | null> {
        const definition = this.sidecar.definition;
        const cwd = definition.cwd === undefined
            ? this.sidecar.extensionDirectory
            : resolve(this.sidecar.extensionDirectory, definition.cwd);
        const log = openLog(this.logPath);
        let child: Bun.Subprocess;
        try {
            child = Bun.spawn({
                cmd: [...definition.command],
                cwd,
                env: {
                    ...process.env,
                    ...definition.env,
                    VERA_SOCKET: this.socketPath,
                },
                stdin: "ignore",
                stdout: log,
                stderr: log,
            });
        } catch (error) {
            closeSync(log);
            return `sidecar failed to spawn: ${errorMessage(error)}`;
        }
        this.child = child;
        this.enter("running");
        try {
            await child.exited;
        } finally {
            closeSync(log);
        }
        if (signal.aborted || this.stopping) {
            return null;
        }
        if (child.signalCode !== null) {
            return `sidecar was killed by ${child.signalCode}`;
        }
        return child.exitCode === 0
            ? null
            : `sidecar exited with code ${child.exitCode}`;
    }

    private noteFailure(message: string): void {
        this.lastError = message;
        this.consecutiveFailures += 1;
        const now = this.clock();
        this.failureTimes.push(now);
        this.failureTimes = this.failureTimes.filter(
            (at) => now - at <= this.timing.failureWindowMs,
        );
    }

    /** A run that lasted forgets the window as well as the ladder. */
    private resetFailureLadder(): void {
        this.consecutiveFailures = 1;
        this.failureTimes = [];
    }

    private ranLongEnough(startedAt: number): boolean {
        return this.clock() - startedAt >= this.timing.healthyRunMs;
    }

    private shouldQuarantine(): boolean {
        return this.failureTimes.length >= this.timing.failuresBeforeQuarantine;
    }

    /** Exponential with full jitter, so restarts of many sidecars do not align. */
    private backoffMs(): number {
        const step = Math.min(
            this.timing.maxBackoffMs,
            this.timing.baseBackoffMs
                * 2 ** Math.max(0, this.consecutiveFailures - 1),
        );
        return Math.max(1, Math.floor(this.random() * step));
    }

    private enter(state: SidecarState): void {
        if (this.state === state) {
            return;
        }
        this.enterUnconditionally(state);
    }

    /** The state is recorded before the listener runs, so a listener that
     * throws cannot leave `status()` describing a state the sidecar left. */
    private enterUnconditionally(state: SidecarState): void {
        this.state = state;
        try {
            this.onStateChange(this.status());
        } catch {
            // A status listener is a diagnostic, never part of supervision.
        }
    }
}

export interface SidecarRuntimeOptions {
    readonly sidecars: readonly OwnedSidecarContribution[];
    readonly socketPath: string;
    readonly logDirectory: string;
    readonly timing?: Partial<SidecarTiming>;
    readonly onStateChange?: (status: SidecarStatus) => void;
}

export interface SidecarRuntime {
    statuses(): readonly SidecarStatus[];
    close(): Promise<void>;
}

export function startSidecarRuntime(
    options: SidecarRuntimeOptions,
): SidecarRuntime {
    const supervised: SupervisedSidecar[] = [];
    for (const sidecar of options.sidecars) {
        const task = new SupervisedSidecar({
            sidecar,
            socketPath: options.socketPath,
            logPath: join(
                options.logDirectory,
                `${sidecar.id.replaceAll("/", ".")}.log`,
            ),
            ...(options.timing === undefined ? {} : { timing: options.timing }),
            ...(options.onStateChange === undefined
                ? {}
                : { onStateChange: options.onStateChange }),
        });
        supervised.push(task);
        task.start();
    }

    return {
        statuses(): readonly SidecarStatus[] {
            return supervised.map((task) => task.status());
        },
        async close(): Promise<void> {
            await Promise.all(supervised.map((task) => task.stop()));
        },
    };
}

export function startSidecarRuntimeIfNeeded(
    options: SidecarRuntimeOptions,
): SidecarRuntime | null {
    return options.sidecars.length === 0 ? null : startSidecarRuntime(options);
}

function openLog(path: string): number {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const file = openSync(path, "a", 0o600);
    fchmodSync(file, 0o600);
    return file;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        timer.unref?.();
        const onAbort = (): void => {
            clearTimeout(timer);
            resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
