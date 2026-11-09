import { spawn, type ChildProcess } from "node:child_process";

import { type ControlPeer, type ControlEventHandler, type ControlHandler } from "./control.ts";
import { startWorkerControlServer, type WorkerControlServer } from "./control-server.ts";
import type { SessionSnapshot } from "./session-endpoint.ts";
import type { WorkerBootstrap } from "./worker-control.ts";
import { sessionWorkerSpawnSpec } from "./worker-launch.ts";
import { adoptWorkerRecord, publishWorkerRecord, type RecoverableWorker, type WorkerRecordHandle } from "./worker-record.ts";
import { killWorkerProcess, stopWorkerProcess, type WorkerStopIdentity } from "./stop-worker.ts";
import { checkRecordIdentity, processIsAlive } from "../process-identity.ts";
import { requestHostIdentity } from "../protocol.ts";
import { verifiedWorkerHello } from "./worker-sockets.ts";

export { controlSocketPath } from "./control-server.ts";

export interface WorkerSpawnSpec {
    readonly command: string;
    readonly args: readonly string[];
}

export class WorkerGenerations {
    private readonly values = new Map<string, number>();

    next(workerId: string): number {
        const generation = (this.values.get(workerId) ?? 0) + 1;
        if (!Number.isSafeInteger(generation)) throw new Error("Session worker generation exhausted");
        this.values.set(workerId, generation);
        return generation;
    }

    observe(workerId: string, generation: number): void {
        if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error("Invalid session worker generation");
        this.values.set(workerId, Math.max(this.values.get(workerId) ?? 0, generation));
    }
}

export interface SessionWorkerSupervisorOptions {
    readonly home: string;
    readonly socket: string;
    readonly index?: number;
    readonly count?: number;
    readonly control?: WorkerControlServer;
    readonly generation: number;
    readonly bootstrap: WorkerBootstrap;
    readonly handler: ControlHandler;
    readonly onEvent: ControlEventHandler;
    readonly onConnected: (peer: ControlPeer) => void;
    readonly onReady?: () => void;
    readonly onSpawn?: (pid: number, startedAt?: string) => void;
    readonly spawnSpec?: WorkerSpawnSpec;
    readonly startupTimeoutMs?: number;
    readonly adopt?: RecoverableWorker;
}

export interface SessionWorkerSupervisor {
    readonly pid: number;
    readonly startedAt: string;
    readonly peer: ControlPeer;
    readonly snapshot: SessionSnapshot;
    readonly exited: Promise<number | null>;
    kill(): void;
    close(): Promise<void>;
}

export async function startSessionWorkerSupervisor(options: SessionWorkerSupervisorOptions): Promise<SessionWorkerSupervisor> {
    if (!Number.isSafeInteger(options.generation) || options.generation <= 0) {
        throw new Error("Invalid session worker generation");
    }
    const index = options.index ?? 0;
    const count = options.count ?? 1;
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 0 || count <= index) {
        throw new Error("Invalid session worker index or count");
    }
    const ownedControl = options.control === undefined ? await startWorkerControlServer(options.home) : undefined;
    const control = options.control ?? ownedControl!;
    let child: ChildProcess | undefined;
    let peer: ControlPeer | undefined;
    let stderr = "";
    let record: Promise<WorkerRecordHandle> | undefined;
    let childIdentity: WorkerStopIdentity | undefined;
    let adoptedReady = false;
    let startedAt: string | undefined;
    const ready = Promise.withResolvers<SessionSnapshot>();
    const unregister = control.register(`w${index}`, async (candidate, hello) => {
        if (peer !== undefined || hello.id !== `w${index}` || hello.index !== index || hello.count !== count
            || hello.pid !== (options.adopt?.record.pid ?? child?.pid) || hello.socket !== options.socket
            || hello.build_id !== options.bootstrap.buildId || typeof hello.started_at !== "string") {
            throw new Error("Invalid session worker identity");
        }
        if (options.adopt !== undefined && hello.started_at !== options.adopt.record.started_at) {
            throw new Error("Invalid session worker identity");
        }
        if (options.adopt?.unrecorded === true) {
            const identity = await requestHostIdentity(options.socket);
            if (!verifiedWorkerHello({ index, path: options.socket, identity }, hello, options.bootstrap.buildId)) {
                throw new Error("Invalid session worker identity");
            }
        }
        startedAt = hello.started_at;
        peer = candidate;
        candidate.setHandler(async (method, args, signal) => {
            if (method === "ready") {
                const snapshot = args[0] as SessionSnapshot | undefined;
                if (snapshot === undefined || !Array.isArray(snapshot.residents) || !Array.isArray(snapshot.summaries)) {
                    throw new Error("Invalid session worker ready message");
                }
                adoptedReady = true;
                options.onReady?.();
                ready.resolve(snapshot);
                return;
            }
            return await options.handler(method, args, signal);
        });
        candidate.setEventHandler(options.onEvent);
        record = options.adopt === undefined
            ? publishWorkerRecord(options.home, hello, control.path)
            : adoptWorkerRecord(options.home, options.adopt.record, hello, control.path);
        await record;
        options.onConnected(candidate);
        void candidate.closed.then(() => ready.reject(new Error("Session worker control connection closed")));
        return options.adopt === undefined ? options.bootstrap : { ...options.bootstrap, adopt: true };
    });
    if (options.adopt === undefined) {
        const spec = options.spawnSpec ?? sessionWorkerSpawnSpec();
        const args = [...spec.args, "--worker-index", String(index), "--worker-count", String(count), "--worker-generation", String(options.generation), "--control", control.path, "--socket", options.socket];
        const spawnedAt = new Date().toISOString();
        child = spawn(spec.command, args, {
            cwd: process.cwd(), env: { ...process.env, VERA_HOME: options.home }, stdio: ["ignore", "ignore", "pipe"],
        });
        if (child.pid !== undefined) {
            childIdentity = { pid: child.pid, started_at: spawnedAt };
            options.onSpawn?.(child.pid, spawnedAt);
        }
        child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_384); });
    }
    const pid = options.adopt?.record.pid ?? child?.pid;
    const identity = options.adopt?.record ?? childIdentity;
    const monitor = new AbortController();
    const recorded = options.adopt === undefined ? undefined : monitorRecordedProcess(options.adopt.record, monitor.signal);
    const ended = options.adopt === undefined
        ? new Promise<number | null>((resolve) => child!.once("close", (code) => resolve(code)))
        : recorded!.exited;
    const exited = ended.then(async (code) => {
        const published = await record?.catch(() => undefined);
        await published?.remove();
        return code;
    });
    const spawnError = new Promise<never>((_resolve, reject) => child?.once("error", reject));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed: Promise<void> | undefined;
    const close = (): Promise<void> => {
        if (closed !== undefined) return closed;
        closed = (async () => {
            unregister();
            if (options.adopt?.unrecorded === true && !adoptedReady) {
                monitor.abort();
                peer?.close();
                await peer?.closed;
                await ownedControl?.close();
                return;
            }
            if (peer !== undefined) {
                await Promise.race([peer.event("shutdown").catch(() => {}), new Promise<void>((resolve) => setTimeout(resolve, 250))]);
                peer.close();
                await peer.closed;
            }
            try {
                if (identity !== undefined) await stopWorkerProcess(identity);
                recorded?.check();
                await exited;
            } finally {
                await ownedControl?.close();
            }
        })();
        return closed;
    };
    try {
        const snapshot = await Promise.race([
            ready.promise,
            exited.then((code): never => { throw new Error(`Session worker exited before ready (${code}): ${stderr.trim()}`); }),
            spawnError,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("Session worker startup timed out")), options.startupTimeoutMs ?? 10_000);
            }),
        ]);
        if (peer === undefined || pid === undefined || startedAt === undefined) throw new Error("Session worker did not connect");
        return { pid, startedAt, peer, snapshot, exited, kill: () => {
            if (identity !== undefined) killWorkerProcess(identity);
        }, close };
    } catch (error) {
        await close();
        if (stderr.split(/\r?\n/).some((line) => line.trim() === "worker_socket_busy")) throw new Error("worker_socket_busy");
        throw error;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

function monitorRecordedProcess(
    record: { readonly pid: number; readonly started_at: string },
    signal: AbortSignal,
): { readonly exited: Promise<number | null>; check(): void } {
    let check = (): void => {};
    const exited = new Promise<number | null>((resolve) => {
        check = () => {
            if (processIsAlive(record.pid) && checkRecordIdentity(record) !== "mismatch") return;
            clearInterval(timer);
            signal.removeEventListener("abort", stop);
            resolve(null);
        };
        const timer = setInterval(check, 1_000);
        const stop = (): void => { clearInterval(timer); };
        signal.addEventListener("abort", stop, { once: true });
        timer.unref();
    });
    return { exited, check: () => check() };
}
