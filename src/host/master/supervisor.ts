import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { dirname, join } from "node:path";

import { acceptHostConnection } from "../connection.ts";
import { defaultHostSocketPath } from "../lockfile.ts";
import { ControlPeer, type ControlEventHandler, type ControlHandler } from "./control.ts";
import type { SessionSnapshot } from "./session-endpoint.ts";
import type { WorkerBootstrap, WorkerHello } from "./worker-control.ts";
import { sessionWorkerSpawnSpec } from "./worker-launch.ts";

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
}

export interface SessionWorkerSupervisorOptions {
    readonly home: string;
    readonly socket: string;
    readonly generation: number;
    readonly bootstrap: WorkerBootstrap;
    readonly handler: ControlHandler;
    readonly onEvent: ControlEventHandler;
    readonly onConnected: (peer: ControlPeer) => void;
    readonly onSpawn?: (pid: number) => void;
    readonly spawnSpec?: WorkerSpawnSpec;
    readonly startupTimeoutMs?: number;
}

export interface SessionWorkerSupervisor {
    readonly pid: number;
    readonly peer: ControlPeer;
    readonly snapshot: SessionSnapshot;
    readonly exited: Promise<number | null>;
    close(): Promise<void>;
}

export function controlSocketPath(home: string): string {
    const path = join(dirname(defaultHostSocketPath(home)), "control.sock");
    if (Buffer.byteLength(path, "utf8") >= 104) {
        throw new Error(`Control socket path exceeds the 103-byte limit: ${path}`);
    }
    return path;
}

export async function startSessionWorkerSupervisor(options: SessionWorkerSupervisorOptions): Promise<SessionWorkerSupervisor> {
    if (!Number.isSafeInteger(options.generation) || options.generation <= 0) {
        throw new Error("Invalid session worker generation");
    }
    const control = controlSocketPath(options.home);
    await removeStaleControlSocket(control);
    let child: ChildProcess | undefined;
    let peer: ControlPeer | undefined;
    let helloSeen = false;
    let stderr = "";
    const ready = Promise.withResolvers<SessionSnapshot>();
    const server: Server = createServer((socket) => {
        if (peer !== undefined) { socket.destroy(); return; }
        const candidate = new ControlPeer(acceptHostConnection(socket));
        peer = candidate;
        candidate.setHandler(async (method, args, signal) => {
            if (!helloSeen) {
                const hello = args[0] as WorkerHello | undefined;
                if (method !== "hello" || hello?.id !== "w0" || hello.index !== 0 || hello.count !== 1
                    || hello.pid !== child?.pid || hello.socket !== options.socket
                    || hello.build_id !== options.bootstrap.buildId || typeof hello.started_at !== "string") {
                    throw new Error("Invalid session worker identity");
                }
                helloSeen = true;
                options.onConnected(candidate);
                return options.bootstrap;
            }
            if (method === "ready") {
                const snapshot = args[0] as SessionSnapshot | undefined;
                if (snapshot === undefined || !Array.isArray(snapshot.residents) || !Array.isArray(snapshot.summaries)) {
                    throw new Error("Invalid session worker ready message");
                }
                ready.resolve(snapshot);
                return;
            }
            return await options.handler(method, args, signal);
        });
        candidate.setEventHandler(options.onEvent);
        void candidate.closed.then(() => ready.reject(new Error("Session worker control connection closed")));
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(control, () => { server.off("error", reject); resolve(); });
    });
    await chmod(control, 0o600);
    const owned = await lstat(control);
    const spec = options.spawnSpec ?? sessionWorkerSpawnSpec();
    const args = [...spec.args, "--worker-index", "0", "--worker-count", "1", "--worker-generation", String(options.generation), "--control", control, "--socket", options.socket];
    child = spawn(spec.command, args, {
        cwd: process.cwd(), env: { ...process.env, VERA_HOME: options.home }, stdio: ["ignore", "ignore", "pipe"],
    });
    if (child.pid !== undefined) options.onSpawn?.(child.pid);
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_384); });
    const exited = new Promise<number | null>((resolve) => child!.once("close", (code) => resolve(code)));
    const spawnError = new Promise<never>((_resolve, reject) => child!.once("error", reject));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed: Promise<void> | undefined;
    const close = (): Promise<void> => {
        if (closed !== undefined) return closed;
        closed = (async () => {
            if (peer !== undefined) {
                await Promise.race([peer.event("shutdown").catch(() => {}), new Promise<void>((resolve) => setTimeout(resolve, 250))]);
                peer.close();
                await peer.closed;
            }
            if (child?.exitCode === null && child.signalCode === null) {
                if (!await finishesWithin(exited, 1_500)) child.kill("SIGTERM");
                if (!await finishesWithin(exited, 1_500)) child.kill("SIGKILL");
            }
            await exited;
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await removeOwnedSocket(control, owned);
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
        if (peer === undefined || child.pid === undefined) throw new Error("Session worker did not connect");
        return { pid: child.pid, peer, snapshot, exited, close };
    } catch (error) {
        await close();
        throw error;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function finishesWithin(exited: Promise<number | null>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            exited.then(() => true),
            new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function removeStaleControlSocket(path: string): Promise<void> {
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
    });
    if (stat === undefined) return;
    if (!stat.isSocket()) throw new Error(`Control socket path is occupied: ${path}`);
    const listening = await new Promise<boolean>((resolve) => {
        const socket = createConnection(path);
        const timer = setTimeout(() => { socket.destroy(); resolve(true); }, 250);
        socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
        socket.once("error", () => { clearTimeout(timer); resolve(false); });
    });
    if (listening) throw new Error(`Control socket is already in use: ${path}`);
    await removeOwnedSocket(path, stat);
}

async function removeOwnedSocket(path: string, owned: Awaited<ReturnType<typeof lstat>>): Promise<void> {
    const current = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
    });
    if (current?.isSocket() && current.dev === owned.dev && current.ino === owned.ino) await unlink(path);
}
