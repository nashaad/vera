import { randomUUID } from "node:crypto";

import { signalVerifiedProcess, signalVerifiedProcessGroup } from "../process-group.ts";
import { captureMarker } from "./bounded-capture.ts";
import { MAX_LIVE_PROCESSES_PER_OWNER } from "./process-limits.ts";
export { MAX_LIVE_PROCESSES_PER_OWNER } from "./process-limits.ts";
import type {
    CommandSandbox,
    SandboxPreparation,
    SandboxPreparedCommand,
    SandboxUnwrappedCommand,
} from "../sandbox/types.ts";

export const DEFAULT_BASH_YIELD_MS = 10_000;
export const MAX_BASH_YIELD_MS = 60_000;
export const MAX_RETAINED_PROCESSES_PER_OWNER = 32;
export const PROCESS_EXIT_RETENTION_MS = 10 * 60_000;
export const PROCESS_OUTPUT_HEAD_BYTES = 4 * 1024;
export const PROCESS_OUTPUT_TAIL_BYTES = 64 * 1024;
const PROCESS_STOP_DRAIN_GRACE_MS = 500;
const PROCESS_TERMINATION_WAIT_MS = 2_000;
const PROCESS_GROUP_POLL_MS = 50;
const PROCESS_OBSERVATION_TAIL_BYTES = 8 * 1024;

export interface ManagedProcessObservation {
    readonly extensionId: string;
    readonly description: string;
}

export interface ManagedProcessObservationStart extends ManagedProcessObservation {
    readonly ownerId: string;
    readonly processId: string;
    readonly pid: number;
    readonly startedAt: string;
}

export interface ManagedProcessObservationSettlement extends ManagedProcessObservationStart {
    readonly elapsedMs: number;
    readonly exitCode?: number;
    readonly outputTail: string;
    readonly outputTruncated: boolean;
}

export interface ManagedProcessSnapshot {
    readonly processId: string;
    readonly command: string;
    readonly pid: number;
    readonly status: "running" | "exited";
    readonly elapsedMs: number;
    readonly output: string;
    readonly exitCode?: number;
    readonly terminationError?: string;
}

export type ManagedProcessRunResult =
    | {
        readonly kind: "exited";
        readonly snapshot: ManagedProcessSnapshot;
    }
    | {
        readonly kind: "aborted";
        readonly snapshot: ManagedProcessSnapshot;
        readonly terminated: boolean;
    }
    | {
        readonly kind: "running";
        readonly snapshot: ManagedProcessSnapshot;
    }
    | {
        readonly kind: "rejected";
        readonly reason: string;
    };

/** Who started a command, for the sandbox policy and the host log. */
export interface SandboxCommandIdentity {
    readonly sessionId: string;
    readonly scratchDir?: string;
    readonly toolCallId?: string;
    readonly approvalMode?: string;
}

export interface ManagedProcessRunOptions {
    readonly command: string;
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly signal?: AbortSignal;
    readonly yieldAfterMs?: number;
    readonly interactive: boolean;
    readonly sandbox?: SandboxCommandIdentity;
    readonly observation?: ManagedProcessObservation;
}

/** Host-owned callbacks, including the loss of one child executor. */
export interface ManagedProcessObservationHandlers {
    readonly onObservationStarted?: (start: ManagedProcessObservationStart) => Promise<void>;
    readonly onObservationSettled?: (settlement: ManagedProcessObservationSettlement) => Promise<void>;
    readonly onObservationInterrupted?: (start: ManagedProcessObservationStart) => Promise<void>;
}

export interface ManagedProcessRegistryOptions {
    readonly maxLivePerOwner?: number;
    readonly maxRetainedPerOwner?: number;
    readonly exitRetentionMs?: number;
    readonly now?: () => number;
    readonly id?: () => string;
    readonly generation?: string;
    readonly stopWaitMs?: number;
    readonly groupPollMs?: number;
    readonly signalProcessTree?: (pid: number) => string | undefined;
    readonly processGroupAlive?: (pid: number) => boolean;
    readonly onProcessStarted?: (pid: number, startedAt: string, ownerId: string) => void;
    readonly onProcessSettled?: (pid: number, ownerId: string) => void;
    readonly onLiveCountChanged?: (ownerId: string, count: number) => void;
    readonly onObservationStarted?: (start: ManagedProcessObservationStart) => Promise<void>;
    readonly onObservationSettled?: (settlement: ManagedProcessObservationSettlement) => Promise<void>;
    readonly onObservationInterrupted?: (start: ManagedProcessObservationStart) => Promise<void>;
    readonly sandbox?: CommandSandbox;
}

interface OutputChunk {
    readonly channel: "stdout" | "stderr";
    readonly bytes: Uint8Array;
}

interface SpawnedProcess {
    readonly pid: number;
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stderr: ReadableStream<Uint8Array>;
    readonly exited: Promise<number>;
}

interface ManagedProcessRecord {
    readonly processId: string;
    readonly ownerId: string;
    readonly command: string;
    readonly startedAt: number;
    readonly identityStartedAt: string;
    readonly subprocess: SpawnedProcess;
    readonly output: ProcessOutputBuffer;
    readonly captures: readonly StreamCapture[];
    readonly sandbox?: SandboxPreparedCommand;
    readonly sandboxUnwrapped?: SandboxUnwrappedCommand;
    readonly sandboxNotice?: string;
    sandboxReported: boolean;
    readonly completion: Promise<void>;
    readonly resolveCompletion: () => void;
    observation?: ManagedProcessObservationStart;
    observationStarted?: Promise<void>;
    observationSettled?: Promise<void>;
    visible: boolean;
    background: boolean;
    leaderExited: boolean;
    groupExited: boolean;
    capturesDrained: boolean;
    exitCode?: number;
    finishedAt?: number;
    terminationError?: string;
    retentionTimer?: ReturnType<typeof setTimeout>;
    stopDrainTimer?: ReturnType<typeof setTimeout>;
    exitDrainTimer?: ReturnType<typeof setTimeout>;
    groupPollTimer?: ReturnType<typeof setTimeout>;
}

interface StreamCapture {
    readonly completion: Promise<void>;
    cancel(): void;
}

function applySandboxSuffix(
    snapshot: ManagedProcessSnapshot,
    suffix: string,
): ManagedProcessSnapshot {
    if (suffix === "") return snapshot;
    const output = snapshot.output === "(no output)"
        ? suffix.replace(/^\n+/, "")
        : `${snapshot.output}${suffix}`;
    return { ...snapshot, output };
}

export class ManagedProcessRegistry {
    private readonly records = new Map<string, ManagedProcessRecord>();
    private readonly unsettledObservations = new Map<string, number>();
    private readonly maxLivePerOwner: number;
    private readonly maxRetainedPerOwner: number;
    private readonly exitRetentionMs: number;
    private readonly clock: () => number;
    private readonly nextId: () => string;
    private readonly stopWaitMs: number;
    private readonly groupPollMs: number;
    private readonly signalTree: ((pid: number) => string | undefined) | undefined;
    private readonly groupAlive: (pid: number) => boolean;
    private readonly onProcessStarted: (pid: number, startedAt: string, ownerId: string) => void;
    private readonly onProcessSettled: (pid: number, ownerId: string) => void;
    private readonly onLiveCountChanged: (ownerId: string, count: number) => void;
    private onObservationStarted: ManagedProcessRegistryOptions["onObservationStarted"];
    private onObservationSettled: ManagedProcessRegistryOptions["onObservationSettled"];
    private onObservationInterrupted: ManagedProcessRegistryOptions["onObservationInterrupted"];
    readonly sandbox: CommandSandbox | undefined;
    private idSequence = 0;
    private closed = false;

    constructor(options: ManagedProcessRegistryOptions = {}) {
        this.maxLivePerOwner = positiveInteger(
            options.maxLivePerOwner ?? MAX_LIVE_PROCESSES_PER_OWNER,
            "live process limit",
        );
        this.maxRetainedPerOwner = positiveInteger(
            options.maxRetainedPerOwner ?? MAX_RETAINED_PROCESSES_PER_OWNER,
            "retained process limit",
        );
        if (this.maxRetainedPerOwner < this.maxLivePerOwner) {
            throw new Error("retained process limit cannot be below the live limit");
        }
        this.exitRetentionMs = positiveFinite(
            options.exitRetentionMs ?? PROCESS_EXIT_RETENTION_MS,
            "process retention",
        );
        this.stopWaitMs = positiveFinite(
            options.stopWaitMs ?? PROCESS_TERMINATION_WAIT_MS,
            "process termination wait",
        );
        this.groupPollMs = positiveFinite(
            options.groupPollMs ?? PROCESS_GROUP_POLL_MS,
            "process group poll interval",
        );
        this.clock = options.now ?? Date.now;
        const generation = options.generation ?? randomUUID();
        if (generation.length === 0) {
            throw new Error("process registry generation cannot be empty");
        }
        this.nextId = options.id
            ?? (() => `p-${generation}-${(++this.idSequence).toString(36)}`);
        this.signalTree = options.signalProcessTree;
        this.groupAlive = options.processGroupAlive ?? processGroupAlive;
        this.onProcessStarted = options.onProcessStarted ?? (() => {});
        this.onProcessSettled = options.onProcessSettled ?? (() => {});
        this.onObservationStarted = options.onObservationStarted;
        this.onObservationSettled = options.onObservationSettled;
        this.onObservationInterrupted = options.onObservationInterrupted;
        this.onLiveCountChanged = options.onLiveCountChanged ?? (() => {});
        this.sandbox = options.sandbox;
    }

    bindObservationHandlers(handlers: ManagedProcessObservationHandlers): void {
        if (this.records.size > 0 || this.onObservationStarted !== undefined || this.onObservationSettled !== undefined) {
            throw new Error("Process observation handlers are already in use");
        }
        this.onObservationStarted = handlers.onObservationStarted;
        this.onObservationSettled = handlers.onObservationSettled;
        this.onObservationInterrupted = handlers.onObservationInterrupted;
    }

    /** The wrapper this registry hands every command, when it has one. */
    get commandSandbox(): CommandSandbox | undefined {
        return this.sandbox;
    }

    scope(ownerId: string): ManagedProcessScope {
        if (ownerId.length === 0) {
            throw new Error("process owner id cannot be empty");
        }
        return new ManagedProcessScope(this, ownerId);
    }

    hasLiveProcesses(): boolean {
        return [...this.records.values()]
            .some((record) => record.finishedAt === undefined);
    }

    hasUnsettledObservedProcess(ownerId: string): boolean {
        return (this.unsettledObservations.get(ownerId) ?? 0) > 0;
    }

    liveCount(ownerId: string): number {
        return this.ownerRecords(ownerId)
            .filter((record) => record.background && record.finishedAt === undefined).length;
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        const records = [...this.records.values()];
        const stopped = await Promise.all(records.map((record) => this.stopAndWait(record)));
        await Promise.allSettled(records.map((record) => record.observationSettled));
        for (const [index, record] of records.entries()) {
            if (!stopped[index] && record.terminationError !== undefined) process.stderr.write(`${record.terminationError}\n`);
        }
        for (const record of records) this.remove(record);
    }

    async run(
        ownerId: string,
        options: ManagedProcessRunOptions,
    ): Promise<ManagedProcessRunResult> {
        options.signal?.throwIfAborted();
        if (this.closed) {
            return { kind: "rejected", reason: "Process registry is closed." };
        }
        if (options.interactive) {
            return {
                kind: "rejected",
                reason: "Interactive process input is not available in this build.",
            };
        }
        if (options.observation !== undefined && (
            this.onObservationStarted === undefined || this.onObservationSettled === undefined
        )) {
            return { kind: "rejected", reason: "Process observation is unavailable in this session." };
        }
        this.pruneOwner(ownerId);
        const live = this.ownerRecords(ownerId)
            .filter((record) => record.finishedAt === undefined).length;
        if (live >= this.maxLivePerOwner) {
            return {
                kind: "rejected",
                reason: `Process limit reached (${this.maxLivePerOwner} live for this session).`,
            };
        }
        this.makeRetainedRoom(ownerId);

        // Allocate before spawn: an allocator failure must not leave an unregistered child that no caller can address.
        const processId = this.uniqueId();
        const preparation = await this.prepareSandbox(options, processId);
        if (preparation.refusal !== undefined) {
            return { kind: "rejected", reason: preparation.refusal };
        }
        const prepared = preparation.prepared;
        if (options.observation !== undefined
            && (this.unsettledObservations.get(ownerId) ?? 0) >= this.maxRetainedPerOwner) {
            if (prepared !== undefined) this.sandbox?.commandEnded(prepared);
            return {
                kind: "rejected",
                reason: `Process observation limit reached (${this.maxRetainedPerOwner} awaiting settlement for this session).`,
            };
        }
        // Record the spawn identity after potentially slow sandbox preparation.
        const identityStartedAt = new Date().toISOString();
        const subprocess = (() => {
            try {
                return Bun.spawn(
                    prepared === undefined
                        ? ["bash", "-lc", options.command]
                        : [...prepared.argv],
                    {
                        cwd: options.cwd,
                        stdin: "ignore",
                        stdout: "pipe",
                        stderr: "pipe",
                        detached: process.platform !== "win32",
                        env: prepared?.env ?? options.env,
                    },
                );
            } catch (error) {
                // srt created per-command state for this wrap; nothing will
                // run, so release it now rather than at shutdown.
                if (prepared !== undefined) this.sandbox?.commandEnded(prepared);
                throw error;
            }
        })();
        const output = new ProcessOutputBuffer(options.observation !== undefined);
        const captures = [
            capture(subprocess.stdout, "stdout", output),
            capture(subprocess.stderr, "stderr", output),
        ];
        const lifecycle = deferred();
        const record: ManagedProcessRecord = {
            processId,
            ownerId,
            command: options.command,
            startedAt: this.clock(),
            identityStartedAt,
            subprocess,
            output,
            captures,
            ...(prepared === undefined ? {} : { sandbox: prepared }),
            ...(preparation.unwrapped === undefined
                ? {}
                : { sandboxUnwrapped: preparation.unwrapped }),
            ...(preparation.notice === undefined
                ? {}
                : { sandboxNotice: preparation.notice }),
            sandboxReported: false,
            completion: lifecycle.promise,
            resolveCompletion: lifecycle.resolve,
            visible: false,
            background: false,
            leaderExited: false,
            groupExited: false,
            capturesDrained: false,
        };
        this.records.set(record.processId, record);
        this.onProcessStarted(record.subprocess.pid, record.identityStartedAt, ownerId);
        if (options.observation !== undefined) {
            this.unsettledObservations.set(ownerId, (this.unsettledObservations.get(ownerId) ?? 0) + 1);
            record.observation = {
                ...options.observation,
                ownerId,
                processId,
                pid: subprocess.pid,
                startedAt: identityStartedAt,
            };
            record.observationStarted = Promise.resolve().then(() =>
                this.onObservationStarted!(record.observation!)
            );
        }
        void Promise.all(captures.map((stream) => stream.completion)).then(() => {
            record.capturesDrained = true;
            this.finishIfSettled(record);
        });
        void subprocess.exited.then(
            (exitCode) => this.onLeaderExit(record, exitCode),
            (error) => {
                output.append(
                    "stderr",
                    new TextEncoder().encode(
                        `\n[vera] could not observe shell exit: ${errorMessage(error)}\n`,
                    ),
                );
                this.onLeaderExit(record, 1);
            },
        );

        let resolveAbort: (() => void) | undefined;
        const abort = new Promise<void>((resolve) => {
            resolveAbort = resolve;
        });
        const onAbort = (): void => {
            this.beginStop(record);
            resolveAbort?.();
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted === true) onAbort();
        let abortedWhileRegistering = false;
        if (record.observationStarted !== undefined) {
            try {
                abortedWhileRegistering = await Promise.race([
                    record.observationStarted.then(() => false),
                    abort.then(() => true),
                ]);
            } catch (error) {
                options.signal?.removeEventListener("abort", onAbort);
                const stopped = await this.stopAndWait(record);
                let cleanupError: string | undefined;
                if (stopped) {
                    try {
                        await record.observationSettled;
                    } catch (cleanup) {
                        cleanupError = errorMessage(cleanup);
                    }
                    this.remove(record);
                } else this.setVisible(record, true);
                return {
                    kind: "rejected",
                    reason: `Could not register process observation: ${errorMessage(error)}`
                        + (stopped ? "" : ` Process remains managed as ${processId}.`)
                        + (cleanupError === undefined ? "" : ` Observation cleanup failed: ${cleanupError}`),
                };
            }
        }
        const yieldWait = options.yieldAfterMs === undefined
            ? undefined
            : wait(options.yieldAfterMs);
        let outcome: "exited" | "yielded" | "aborted";
        try {
            outcome = abortedWhileRegistering ? "aborted" : yieldWait === undefined
                ? await Promise.race([
                    record.completion.then(() => "exited" as const),
                    abort.then(() => "aborted" as const),
                ])
                : await Promise.race([
                    record.completion.then(() => "exited" as const),
                    yieldWait.promise.then(() => "yielded" as const),
                    abort.then(() => "aborted" as const),
                ]);
        } finally {
            yieldWait?.cancel();
            options.signal?.removeEventListener("abort", onAbort);
        }

        if (outcome === "aborted") {
            const terminated = await this.stopAndWait(record);
            if (!terminated) this.setVisible(record, true);
            if (terminated && !abortedWhileRegistering && record.observationSettled !== undefined) {
                await record.observationSettled;
            }
            const snapshot = terminated
                ? await this.withSandboxOutcome(record)
                : this.snapshot(record);
            if (terminated) this.remove(record);
            return {
                kind: "aborted",
                snapshot,
                terminated,
            };
        }
        if (outcome === "exited") {
            if (record.observationSettled !== undefined) await record.observationSettled;
            const snapshot = await this.withSandboxOutcome(record);
            this.remove(record);
            return { kind: "exited", snapshot };
        }

        // Ownership has moved out of the foreground turn. A later abort of that turn must not kill a process whose ID was already returned.
        this.setVisible(record, true);
        if (record.finishedAt !== undefined) {
            if (record.observationSettled !== undefined) await record.observationSettled;
            const snapshot = await this.withSandboxOutcome(record);
            this.remove(record);
            return { kind: "exited", snapshot };
        }
        return {
            kind: "running",
            snapshot: applySandboxSuffix(
                this.snapshot(record),
                this.noticeSuffix(record),
            ),
        };
    }

    read(ownerId: string, processId: string): ManagedProcessSnapshot | undefined {
        this.pruneOwner(ownerId);
        const record = this.visibleRecord(ownerId, processId);
        if (record === undefined) return undefined;
        const snapshot = record.finishedAt === undefined
            ? this.snapshot(record)
            : this.withSandboxOutcomeSync(record);
        return snapshot;
    }

    async readSettled(
        ownerId: string,
        processId: string,
    ): Promise<ManagedProcessSnapshot | undefined> {
        this.pruneOwner(ownerId);
        const record = this.visibleRecord(ownerId, processId);
        if (record === undefined) return undefined;
        const snapshot = record.finishedAt === undefined
            ? this.snapshot(record)
            : await this.withSandboxOutcome(record);
        return snapshot;
    }

    async kill(
        ownerId: string,
        processId: string,
    ): Promise<ManagedProcessSnapshot | undefined> {
        this.pruneOwner(ownerId);
        const record = this.visibleRecord(ownerId, processId);
        if (record === undefined) return undefined;
        await this.stopAndWait(record);
        const snapshot = record.finishedAt === undefined
            ? this.snapshot(record)
            : await this.withSandboxOutcome(record);
        return snapshot;
    }

    async closeOwner(ownerId: string): Promise<void> {
        const records = this.ownerRecords(ownerId);
        for (const record of records) this.setVisible(record);
        const stopped = await Promise.all(records.map((record) => this.stopAndWait(record)));
        await Promise.allSettled(records.map((record) => record.observationSettled));
        for (const [index, record] of records.entries()) {
            if (!stopped[index] && record.terminationError !== undefined) process.stderr.write(`${record.terminationError}\n`);
        }
        for (const record of records) {
            if (record.finishedAt !== undefined) this.remove(record);
        }
    }

    private async prepareSandbox(
        options: ManagedProcessRunOptions,
        processId: string,
    ): Promise<SandboxPreparation> {
        if (this.sandbox === undefined) {
            return {};
        }
        // A command from a caller that did not name a session or tool call is
        // still covered: the registry's own process ID stands in for both, so
        // it is wrapped and logged like any other.
        const identity: SandboxCommandIdentity = options.sandbox ?? {
            sessionId: processId,
            toolCallId: processId,
        };
        return this.sandbox.prepare({
            command: options.command,
            cwd: options.cwd,
            env: options.env,
            workspace: options.cwd,
            ...(identity.scratchDir === undefined
                ? {}
                : { scratchDir: identity.scratchDir }),
            sessionId: identity.sessionId,
            toolCallId: identity.toolCallId ?? processId,
            ...(identity.approvalMode === undefined
                ? {}
                : { approvalMode: identity.approvalMode }),
        });
    }

    private async withSandboxOutcome(
        record: ManagedProcessRecord,
    ): Promise<ManagedProcessSnapshot> {
        const snapshot = this.snapshot(record);
        if (this.sandbox === undefined) return snapshot;
        let suffix = this.noticeSuffix(record);
        if (record.sandbox !== undefined) {
            const settled = await this.sandbox.settle(
                record.sandbox,
                record.exitCode ?? null,
            );
            suffix += settled.suffix;
        } else if (
            record.sandboxUnwrapped !== undefined
            && !record.sandboxReported
        ) {
            record.sandboxReported = true;
            this.sandbox.finishUnwrapped(
                record.sandboxUnwrapped,
                record.exitCode ?? null,
            );
        }
        return applySandboxSuffix(snapshot, suffix);
    }

    private withSandboxOutcomeSync(
        record: ManagedProcessRecord,
    ): ManagedProcessSnapshot {
        const snapshot = this.snapshot(record);
        if (this.sandbox === undefined) return snapshot;
        let suffix = this.noticeSuffix(record);
        if (record.sandbox !== undefined) {
            suffix += this.sandbox.settleSync(record.sandbox).suffix;
        } else if (
            record.sandboxUnwrapped !== undefined
            && !record.sandboxReported
        ) {
            record.sandboxReported = true;
            this.sandbox.finishUnwrapped(
                record.sandboxUnwrapped,
                record.exitCode ?? null,
            );
        }
        return applySandboxSuffix(snapshot, suffix);
    }

    private noticeSuffix(record: ManagedProcessRecord): string {
        return record.sandboxNotice === undefined
            ? ""
            : `\n\n${record.sandboxNotice}`;
    }

    private snapshot(record: ManagedProcessRecord): ManagedProcessSnapshot {
        const finishedAt = record.finishedAt;
        return {
            processId: record.processId,
            command: record.command,
            pid: record.subprocess.pid,
            status: finishedAt === undefined ? "running" : "exited",
            elapsedMs: (finishedAt ?? this.clock()) - record.startedAt,
            output: record.output.text() || "(no output)",
            ...(finishedAt === undefined || record.exitCode === undefined
                ? {}
                : { exitCode: record.exitCode }),
            ...(record.terminationError === undefined
                ? {}
                : { terminationError: record.terminationError }),
        };
    }

    private visibleRecord(
        ownerId: string,
        processId: string,
    ): ManagedProcessRecord | undefined {
        const record = this.records.get(processId);
        return record?.visible === true && record.ownerId === ownerId
            ? record
            : undefined;
    }

    private ownerRecords(ownerId: string): ManagedProcessRecord[] {
        return [...this.records.values()]
            .filter((record) => record.ownerId === ownerId);
    }

    private setVisible(record: ManagedProcessRecord, background = false): void {
        record.visible = true;
        if (!background || record.background) return;
        record.background = true;
        if (record.finishedAt === undefined) {
            this.onLiveCountChanged(record.ownerId, this.liveCount(record.ownerId));
        }
    }

    private makeRetainedRoom(ownerId: string): void {
        const records = this.ownerRecords(ownerId);
        if (records.length < this.maxRetainedPerOwner) return;
        const exited = records
            .filter((record) => record.finishedAt !== undefined)
            .sort((left, right) =>
                (left.finishedAt as number) - (right.finishedAt as number)
            );
        while (
            this.ownerRecords(ownerId).length >= this.maxRetainedPerOwner
            && exited.length > 0
        ) {
            this.remove(exited.shift() as ManagedProcessRecord);
        }
    }

    private pruneOwner(ownerId: string): void {
        const cutoff = this.clock() - this.exitRetentionMs;
        for (const record of this.ownerRecords(ownerId)) {
            if (record.finishedAt !== undefined && record.finishedAt <= cutoff) {
                this.remove(record);
            }
        }
    }

    private retainExited(record: ManagedProcessRecord): void {
        if (!record.visible || record.retentionTimer !== undefined) return;
        const timer = setTimeout(() => this.remove(record), this.exitRetentionMs);
        timer.unref?.();
        record.retentionTimer = timer;
    }

    private remove(record: ManagedProcessRecord): void {
        if (this.records.get(record.processId) !== record) return;
        if (record.finishedAt !== undefined) {
            if (record.sandbox !== undefined) {
                this.sandbox?.settleSync(record.sandbox);
            } else if (
                record.sandboxUnwrapped !== undefined
                && !record.sandboxReported
            ) {
                record.sandboxReported = true;
                this.sandbox?.finishUnwrapped(
                    record.sandboxUnwrapped,
                    record.exitCode ?? null,
                );
            }
        }
        if (record.retentionTimer !== undefined) {
            clearTimeout(record.retentionTimer);
        }
        if (record.stopDrainTimer !== undefined) {
            clearTimeout(record.stopDrainTimer);
        }
        if (record.exitDrainTimer !== undefined) {
            clearTimeout(record.exitDrainTimer);
        }
        if (record.groupPollTimer !== undefined) {
            clearTimeout(record.groupPollTimer);
        }
        if (record.finishedAt === undefined) {
            for (const stream of record.captures) stream.cancel();
        }
        this.records.delete(record.processId);
    }

    private beginStop(record: ManagedProcessRecord): void {
        if (record.finishedAt !== undefined) return;
        try {
            record.terminationError = this.signalTree === undefined
                ? stopProcessTree(record.subprocess.pid, record.identityStartedAt)
                : this.signalTree(record.subprocess.pid);
        } catch (error) {
            record.terminationError = errorMessage(error);
        }
        if (record.stopDrainTimer === undefined) {
            record.stopDrainTimer = setTimeout(() => {
                for (const stream of record.captures) stream.cancel();
                record.capturesDrained = true;
                this.finishIfSettled(record);
            }, PROCESS_STOP_DRAIN_GRACE_MS);
            record.stopDrainTimer.unref?.();
        }
    }

    private async stopAndWait(record: ManagedProcessRecord): Promise<boolean> {
        if (record.finishedAt !== undefined) return true;
        this.beginStop(record);
        const deadline = wait(this.stopWaitMs);
        try {
            await Promise.race([record.completion, deadline.promise]);
        } finally {
            deadline.cancel();
        }
        if (record.finishedAt !== undefined) {
            record.terminationError = undefined;
            return true;
        }
        record.terminationError ??=
            `Termination was not confirmed within ${formatSeconds(this.stopWaitMs)}.`;
        return false;
    }

    private onLeaderExit(record: ManagedProcessRecord, exitCode: number): void {
        if (record.leaderExited) return;
        record.leaderExited = true;
        record.exitCode = exitCode;
        if (record.sandbox !== undefined) {
            this.sandbox?.commandEnded(record.sandbox);
        }
        if (process.platform === "win32") {
            this.markGroupExited(record);
            return;
        }
        this.observeProcessGroup(record);
    }

    private observeProcessGroup(record: ManagedProcessRecord): void {
        if (
            record.groupExited
            || this.records.get(record.processId) !== record
        ) {
            return;
        }
        let alive: boolean;
        try {
            alive = this.groupAlive(record.subprocess.pid);
        } catch (error) {
            record.terminationError =
                `Could not inspect the process group: ${errorMessage(error)}`;
            alive = true;
        }
        if (!alive) {
            this.markGroupExited(record);
            return;
        }
        record.groupPollTimer = setTimeout(
            () => {
                record.groupPollTimer = undefined;
                this.observeProcessGroup(record);
            },
            this.groupPollMs,
        );
        record.groupPollTimer.unref?.();
    }

    private markGroupExited(record: ManagedProcessRecord): void {
        if (record.groupExited) return;
        record.groupExited = true;
        if (record.groupPollTimer !== undefined) {
            clearTimeout(record.groupPollTimer);
            record.groupPollTimer = undefined;
        }
        if (!record.capturesDrained && record.exitDrainTimer === undefined) {
            record.exitDrainTimer = setTimeout(() => {
                for (const stream of record.captures) stream.cancel();
                record.capturesDrained = true;
                this.finishIfSettled(record);
            }, PROCESS_STOP_DRAIN_GRACE_MS);
            record.exitDrainTimer.unref?.();
        }
        this.finishIfSettled(record);
    }

    private finishIfSettled(record: ManagedProcessRecord): void {
        if (
            record.finishedAt !== undefined
            || !record.leaderExited
            || !record.groupExited
            || !record.capturesDrained
        ) {
            return;
        }
        for (const timer of [record.stopDrainTimer, record.exitDrainTimer]) {
            if (timer !== undefined) clearTimeout(timer);
        }
        record.stopDrainTimer = undefined;
        record.exitDrainTimer = undefined;
        record.terminationError = undefined;
        record.finishedAt = this.clock();
        this.onProcessSettled(record.subprocess.pid, record.ownerId);
        if (record.observation !== undefined && record.observationStarted !== undefined) {
            const output = record.output.observationTail();
            const settlement: ManagedProcessObservationSettlement = {
                ...record.observation,
                elapsedMs: record.finishedAt - record.startedAt,
                ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
                outputTail: output.text,
                outputTruncated: output.truncated,
            };
            record.observationSettled = record.observationStarted.then(
                () => this.onObservationSettled!(settlement),
                () => {
                    if (this.onObservationInterrupted === undefined) {
                        throw new Error("Uncertain observation cleanup is unavailable");
                    }
                    return this.onObservationInterrupted(record.observation!);
                },
            );
            void record.observationSettled.then(
                () => this.releaseObservation(record.ownerId),
                (error: unknown) => {
                    this.releaseObservation(record.ownerId);
                    process.stderr.write(`Process observation failed: ${errorMessage(error)}\n`);
                },
            );
        }
        if (record.background) {
            this.onLiveCountChanged(record.ownerId, this.liveCount(record.ownerId));
        }
        record.resolveCompletion();
        if (record.visible) this.retainExited(record);
    }

    private releaseObservation(ownerId: string): void {
        const count = this.unsettledObservations.get(ownerId) ?? 0;
        if (count <= 1) this.unsettledObservations.delete(ownerId);
        else this.unsettledObservations.set(ownerId, count - 1);
    }

    private uniqueId(): string {
        for (let attempt = 0; attempt < 100; attempt += 1) {
            const id = this.nextId();
            if (id.length > 0 && !this.records.has(id)) return id;
        }
        throw new Error("Could not allocate a unique process id");
    }
}

export class ManagedProcessScope {
    private closed = false;

    constructor(
        private readonly registry: ManagedProcessRegistry,
        private readonly ownerId: string,
    ) {}

    get sandbox(): CommandSandbox | undefined {
        return this.registry.commandSandbox;
    }

    run(options: ManagedProcessRunOptions): Promise<ManagedProcessRunResult> {
        if (this.closed) {
            return Promise.resolve({
                kind: "rejected",
                reason: "This session's process scope is closed.",
            });
        }
        return this.registry.run(this.ownerId, options);
    }

    read(processId: string): ManagedProcessSnapshot | undefined {
        return this.closed ? undefined : this.registry.read(this.ownerId, processId);
    }

    readSettled(processId: string): Promise<ManagedProcessSnapshot | undefined> {
        return this.closed
            ? Promise.resolve(undefined)
            : this.registry.readSettled(this.ownerId, processId);
    }

    kill(processId: string): Promise<ManagedProcessSnapshot | undefined> {
        return this.closed
            ? Promise.resolve(undefined)
            : this.registry.kill(this.ownerId, processId);
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await this.registry.closeOwner(this.ownerId);
    }
}

class ProcessOutputBuffer {
    private readonly head: OutputChunk[] = [];
    private readonly tail: OutputChunk[] = [];
    private readonly observation: ObservationOutput | undefined;
    private headBytes = 0;
    private tailBytes = 0;
    private totalBytes = 0;

    constructor(observe: boolean) {
        this.observation = observe ? new ObservationOutput() : undefined;
    }

    append(channel: OutputChunk["channel"], value: Uint8Array): void {
        if (value.length === 0) return;
        this.observation?.append(channel, value);
        this.totalBytes += value.length;
        let offset = 0;
        if (this.headBytes < PROCESS_OUTPUT_HEAD_BYTES) {
            const wanted = Math.min(
                value.length,
                PROCESS_OUTPUT_HEAD_BYTES - this.headBytes,
            );
            this.head.push({ channel, bytes: value.slice(0, wanted) });
            this.headBytes += wanted;
            offset = wanted;
        }
        if (offset < value.length) {
            const bytes = value.slice(Math.max(offset, value.length - PROCESS_OUTPUT_TAIL_BYTES));
            this.tail.push({ channel, bytes });
            this.tailBytes += bytes.length;
            this.trimTail();
        }
    }

    text(): string {
        if (this.totalBytes === 0) return "";
        if (this.totalBytes <= PROCESS_OUTPUT_HEAD_BYTES + PROCESS_OUTPUT_TAIL_BYTES) {
            return renderOutput([...this.head, ...this.tail]);
        }
        const head = renderOutput(this.head);
        const tail = renderOutput(this.tail);
        const retained = this.headBytes + this.tailBytes;
        return [
            head,
            captureMarker("process output", this.totalBytes, retained),
            tail,
        ].filter((part) => part.length > 0).join("\n");
    }

    finishChannel(channel: OutputChunk["channel"]): void {
        this.observation?.finishChannel(channel);
    }

    observationTail(): { readonly text: string; readonly truncated: boolean } {
        return this.observation?.tail() ?? { text: "", truncated: false };
    }

    private trimTail(): void {
        while (this.tailBytes > PROCESS_OUTPUT_TAIL_BYTES && this.tail.length > 0) {
            const first = this.tail[0] as OutputChunk;
            const overflow = this.tailBytes - PROCESS_OUTPUT_TAIL_BYTES;
            if (overflow < first.bytes.length) {
                this.tail[0] = {
                    channel: first.channel,
                    bytes: first.bytes.slice(overflow),
                };
                this.tailBytes -= overflow;
                return;
            }
            this.tail.shift();
            this.tailBytes -= first.bytes.length;
        }
    }
}

class ObservationOutput {
    private readonly decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    private readonly encoder = new TextEncoder();
    private readonly bytes = new Uint8Array(PROCESS_OBSERVATION_TAIL_BYTES);
    private start = 0;
    private size = 0;
    private truncated = false;

    append(channel: OutputChunk["channel"], value: Uint8Array): void {
        this.appendText(this.decoders[channel].decode(value, { stream: true }));
    }

    finishChannel(channel: OutputChunk["channel"]): void {
        this.appendText(this.decoders[channel].decode());
    }

    tail(): { readonly text: string; readonly truncated: boolean } {
        const bytes = new Uint8Array(this.size);
        const first = Math.min(this.size, this.bytes.length - this.start);
        bytes.set(this.bytes.subarray(this.start, this.start + first));
        bytes.set(this.bytes.subarray(0, this.size - first), first);
        let offset = 0;
        while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset += 1;
        return {
            text: new TextDecoder().decode(bytes.subarray(offset)),
            truncated: this.truncated || offset > 0,
        };
    }

    private appendText(text: string): void {
        if (text.length === 0) return;
        const bytes = this.encoder.encode(text);
        if (bytes.length >= this.bytes.length) {
            this.truncated ||= this.size > 0 || bytes.length > this.bytes.length;
            this.bytes.set(bytes.subarray(bytes.length - this.bytes.length));
            this.start = 0;
            this.size = this.bytes.length;
            return;
        }
        const overflow = Math.max(0, this.size + bytes.length - this.bytes.length);
        if (overflow > 0) {
            this.start = (this.start + overflow) % this.bytes.length;
            this.size -= overflow;
            this.truncated = true;
        }
        const end = (this.start + this.size) % this.bytes.length;
        const first = Math.min(bytes.length, this.bytes.length - end);
        this.bytes.set(bytes.subarray(0, first), end);
        this.bytes.set(bytes.subarray(first), 0);
        this.size += bytes.length;
    }
}

function capture(
    stream: ReadableStream<Uint8Array>,
    channel: OutputChunk["channel"],
    output: ProcessOutputBuffer,
): StreamCapture {
    const reader = stream.getReader();
    let cancelled = false;
    let finished = false;
    const finish = (): void => {
        if (finished) return;
        finished = true;
        output.finishChannel(channel);
    };
    const completion = (async () => {
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done || cancelled) return;
                if (value !== undefined) output.append(channel, value);
            }
        } catch (error) {
            if (cancelled) return;
            output.append(
                channel,
                new TextEncoder().encode(
                    `\n[vera] ${channel} capture failed: ${errorMessage(error)}\n`,
                ),
            );
        } finally {
            finish();
            try {
                reader.releaseLock();
            } catch {
            }
        }
    })();
    return {
        completion,
        cancel(): void {
            cancelled = true;
            finish();
            void reader.cancel().catch(() => {});
        },
    };
}

function renderOutput(chunks: readonly OutputChunk[]): string {
    const stdout = decode(concat(
        chunks.filter((chunk) => chunk.channel === "stdout")
            .map((chunk) => chunk.bytes),
    ));
    const stderr = decode(concat(
        chunks.filter((chunk) => chunk.channel === "stderr")
            .map((chunk) => chunk.bytes),
    ));
    return [stdout, stderr].filter((text) => text.length > 0).join("\n");
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
    }
    return joined;
}

function decode(bytes: Uint8Array): string {
    return new TextDecoder("utf-8")
        .decode(bytes)
        .replace(/^�+/, "")
        .replace(/�+$/, "");
}

function stopProcessTree(pid: number, startedAt: string): string | undefined {
    try {
        if (process.platform === "win32") {
            const result = Bun.spawnSync(
                ["taskkill", "/pid", String(pid), "/t", "/f"],
                {
                    stdout: "ignore",
                    stderr: "ignore",
                },
            );
            return result.exitCode === 0
                ? undefined
                : `taskkill exited with code ${result.exitCode}`;
        }
        const record = { pid, started_at: startedAt };
        const group = signalVerifiedProcessGroup(record, "SIGKILL");
        if (group === "sent") return undefined;
        const direct = signalVerifiedProcess(record, "SIGKILL");
        if (direct === "sent") return undefined;
        if (direct === "gone") return `PID ${pid} had already exited.`;
        if (direct === "replaced") return `PID ${pid} is no longer the process that was listed; left it alone.`;
        if (direct === "not_delivered") return `Could not signal PID ${pid}; left it running.`;
        return `Could not confirm PID ${pid} is still the process that was listed; left it running.`;
    } catch (error) {
        if (isMissingProcess(error)) return undefined;
        return errorMessage(error);
    }
}

function processGroupAlive(pid: number): boolean {
    if (process.platform === "win32") return false;
    const result = Bun.spawnSync(["ps", "-axo", "pgid="], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "ps failed");
    return result.stdout.toString().split("\n").some((line) => Number(line.trim()) === pid);
}

function wait(ms: number): { readonly promise: Promise<void>; cancel(): void } {
    if (ms === 0) {
        return { promise: Promise.resolve(), cancel(): void {} };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
    return {
        promise,
        cancel(): void {
            if (timer !== undefined) clearTimeout(timer);
        },
    };
}

function deferred(): {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
} {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

function formatSeconds(milliseconds: number): string {
    return `${(milliseconds / 1_000).toFixed(1)}s`;
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive integer`);
    }
    return value;
}

function positiveFinite(value: number, label: string): number {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${label} must be positive and finite`);
    }
    return value;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isMissingProcess(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "ESRCH";
}
