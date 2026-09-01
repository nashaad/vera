import { randomUUID } from "node:crypto";

import { captureMarker } from "./bounded-capture.ts";

export const DEFAULT_BASH_YIELD_MS = 10_000;
export const MAX_BASH_YIELD_MS = 60_000;
export const MAX_LIVE_PROCESSES_PER_OWNER = 8;
export const MAX_RETAINED_PROCESSES_PER_OWNER = 32;
export const PROCESS_EXIT_RETENTION_MS = 10 * 60_000;
export const PROCESS_OUTPUT_HEAD_BYTES = 4 * 1024;
export const PROCESS_OUTPUT_TAIL_BYTES = 64 * 1024;
const PROCESS_STOP_DRAIN_GRACE_MS = 500;
const PROCESS_TERMINATION_WAIT_MS = 2_000;
const PROCESS_GROUP_POLL_MS = 50;

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

export interface ManagedProcessRunOptions {
    readonly command: string;
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly signal?: AbortSignal;
    readonly yieldAfterMs?: number;
    readonly interactive: boolean;
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
    readonly onProcessStarted?: (pid: number) => void;
    readonly onProcessSettled?: (pid: number) => void;
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
    readonly subprocess: SpawnedProcess;
    readonly output: ProcessOutputBuffer;
    readonly captures: readonly StreamCapture[];
    readonly completion: Promise<void>;
    readonly resolveCompletion: () => void;
    visible: boolean;
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

export class ManagedProcessRegistry {
    private readonly records = new Map<string, ManagedProcessRecord>();
    private readonly maxLivePerOwner: number;
    private readonly maxRetainedPerOwner: number;
    private readonly exitRetentionMs: number;
    private readonly clock: () => number;
    private readonly nextId: () => string;
    private readonly stopWaitMs: number;
    private readonly groupPollMs: number;
    private readonly signalTree: (pid: number) => string | undefined;
    private readonly groupAlive: (pid: number) => boolean;
    private readonly onProcessStarted: (pid: number) => void;
    private readonly onProcessSettled: (pid: number) => void;
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
        this.signalTree = options.signalProcessTree ?? stopProcessTree;
        this.groupAlive = options.processGroupAlive ?? processGroupAlive;
        this.onProcessStarted = options.onProcessStarted ?? (() => {});
        this.onProcessSettled = options.onProcessSettled ?? (() => {});
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

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        const records = [...this.records.values()];
        await Promise.all(records.map((record) => this.stopAndWait(record)));
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
        const subprocess = Bun.spawn(["bash", "-lc", options.command], {
            cwd: options.cwd,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            detached: process.platform !== "win32",
            env: options.env,
        });
        const output = new ProcessOutputBuffer();
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
            subprocess,
            output,
            captures,
            completion: lifecycle.promise,
            resolveCompletion: lifecycle.resolve,
            visible: false,
            leaderExited: false,
            groupExited: false,
            capturesDrained: false,
        };
        this.records.set(record.processId, record);
        this.onProcessStarted(record.subprocess.pid);
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
        const yieldWait = options.yieldAfterMs === undefined
            ? undefined
            : wait(options.yieldAfterMs);
        let outcome: "exited" | "yielded" | "aborted";
        try {
            outcome = yieldWait === undefined
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
            if (!terminated) record.visible = true;
            const snapshot = this.snapshot(record);
            if (terminated) this.remove(record);
            return {
                kind: "aborted",
                snapshot,
                terminated,
            };
        }
        if (outcome === "exited") {
            const snapshot = this.snapshot(record);
            this.remove(record);
            return { kind: "exited", snapshot };
        }

        // Ownership has moved out of the foreground turn. A later abort of that turn must not kill a process whose ID was already returned.
        record.visible = true;
        if (record.finishedAt !== undefined) {
            const snapshot = this.snapshot(record);
            this.remove(record);
            return { kind: "exited", snapshot };
        }
        return { kind: "running", snapshot: this.snapshot(record) };
    }

    read(ownerId: string, processId: string): ManagedProcessSnapshot | undefined {
        this.pruneOwner(ownerId);
        const record = this.visibleRecord(ownerId, processId);
        if (record === undefined) return undefined;
        const snapshot = this.snapshot(record);
        if (snapshot.status === "exited") this.remove(record);
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
        const snapshot = this.snapshot(record);
        if (record.finishedAt !== undefined) this.remove(record);
        return snapshot;
    }

    async closeOwner(ownerId: string): Promise<void> {
        const records = this.ownerRecords(ownerId);
        for (const record of records) record.visible = true;
        await Promise.all(records.map((record) => this.stopAndWait(record)));
        for (const record of records) {
            if (record.finishedAt !== undefined) this.remove(record);
        }
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
            record.terminationError = this.signalTree(record.subprocess.pid);
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
        this.onProcessSettled(record.subprocess.pid);
        record.resolveCompletion();
        if (record.visible) this.retainExited(record);
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
    private headBytes = 0;
    private tailBytes = 0;
    private totalBytes = 0;

    append(channel: OutputChunk["channel"], value: Uint8Array): void {
        if (value.length === 0) return;
        this.totalBytes += value.length;
        let offset = 0;
        if (this.headBytes < PROCESS_OUTPUT_HEAD_BYTES) {
            const wanted = Math.min(
                value.length,
                PROCESS_OUTPUT_HEAD_BYTES - this.headBytes,
            );
            this.head.push({ channel, bytes: value.subarray(0, wanted) });
            this.headBytes += wanted;
            offset = wanted;
        }
        if (offset < value.length) {
            const bytes = value.subarray(offset);
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

    private trimTail(): void {
        while (this.tailBytes > PROCESS_OUTPUT_TAIL_BYTES && this.tail.length > 0) {
            const first = this.tail[0] as OutputChunk;
            const overflow = this.tailBytes - PROCESS_OUTPUT_TAIL_BYTES;
            if (overflow < first.bytes.length) {
                this.tail[0] = {
                    channel: first.channel,
                    bytes: first.bytes.subarray(overflow),
                };
                this.tailBytes -= overflow;
                return;
            }
            this.tail.shift();
            this.tailBytes -= first.bytes.length;
        }
    }
}

function capture(
    stream: ReadableStream<Uint8Array>,
    channel: OutputChunk["channel"],
    output: ProcessOutputBuffer,
): StreamCapture {
    const reader = stream.getReader();
    let cancelled = false;
    const completion = (async () => {
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) return;
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

function stopProcessTree(pid: number): string | undefined {
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
        process.kill(-pid, "SIGKILL");
        return undefined;
    } catch (error) {
        if (isMissingProcess(error)) return undefined;
        return errorMessage(error);
    }
}

function processGroupAlive(pid: number): boolean {
    if (process.platform === "win32") return false;
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        return !isMissingProcess(error);
    }
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
