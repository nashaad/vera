import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { dirname, join } from "node:path";

import { acceptHostConnection } from "../connection.ts";
import { defaultHostSocketPath } from "../lockfile.ts";
import { ControlPeer } from "./control.ts";
import type { WorkerHello } from "./worker-control.ts";

type AcceptWorker = (peer: ControlPeer, hello: WorkerHello) => Promise<unknown>;

export interface WorkerControlServer {
    readonly path: string;
    register(id: string, accept: AcceptWorker): () => void;
    close(): Promise<void>;
}

export function controlSocketPath(home: string): string {
    const path = join(dirname(defaultHostSocketPath(home)), "control.sock");
    if (Buffer.byteLength(path, "utf8") >= 104) {
        throw new Error(`Control socket path exceeds the 103-byte limit: ${path}`);
    }
    return path;
}

export async function startWorkerControlServer(home: string): Promise<WorkerControlServer> {
    const path = controlSocketPath(home);
    await removeStaleControlSocket(path);
    const registrations = new Map<string, AcceptWorker>();
    const peers = new Set<ControlPeer>();
    const server = createServer((socket) => {
        const peer = new ControlPeer(acceptHostConnection(socket));
        peers.add(peer);
        void peer.closed.then(() => peers.delete(peer));
        peer.setHandler(async (method, args) => {
            const hello = args[0] as WorkerHello | undefined;
            const accept = typeof hello?.id === "string" ? registrations.get(hello.id) : undefined;
            if (method !== "hello" || accept === undefined) throw new Error("Invalid session worker identity");
            return await accept(peer, hello!);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => { server.off("error", reject); resolve(); });
    });
    await chmod(path, 0o600);
    const owned = await lstat(path);
    let closing: Promise<void> | undefined;
    return {
        path,
        register(id, accept) {
            if (registrations.has(id)) throw new Error("Session worker identity is already registered");
            registrations.set(id, accept);
            return () => { if (registrations.get(id) === accept) registrations.delete(id); };
        },
        close() {
            if (closing === undefined) {
                closing = (async () => {
                    for (const peer of peers) peer.close();
                    await Promise.all([...peers].map((peer) => peer.closed));
                    await new Promise<void>((resolve) => server.close(() => resolve()));
                    await removeOwnedSocket(path, owned);
                })();
            }
            return closing;
        },
    };
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
