import { lstat, readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";

import { defaultHostSocketPath } from "../lockfile.ts";
import { checkRecordIdentity } from "../process-identity.ts";
import { requestHostIdentity, type HostIdentity } from "../protocol.ts";
import { inProcessWorkerSocket } from "./in-process.ts";
import { startWorkerControlServer } from "./control-server.ts";
import type { WorkerHello } from "./worker-control.ts";

export interface WorkerSocket {
    readonly index: number;
    readonly path: string;
    readonly identity?: HostIdentity;
}

export async function occupiedWorkerSockets(home: string, count: number): Promise<WorkerSocket[]> {
    const runtime = dirname(defaultHostSocketPath(home));
    const names = await readdir(runtime).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
    const paths = new Map(Array.from({ length: count }, (_, index) => [inProcessWorkerSocket(home, index), index]));
    for (const name of names) {
        if (!name.startsWith("w") || !name.endsWith(".sock")) continue;
        const match = /^w(0|[1-9]\d*)\.sock$/.exec(name);
        const parsed = match === null ? -1 : Number(match[1]);
        const index = Number.isSafeInteger(parsed) ? parsed : -1;
        paths.set(join(runtime, name), index);
    }
    const sockets = await Promise.all([...paths].map(async ([path, index]) => {
        const identity = await requestHostIdentity(path);
        if (identity !== undefined) return { index, path, identity };
        return await socketOccupied(path) ? { index, path } : undefined;
    }));
    return sockets.filter((socket): socket is WorkerSocket => socket !== undefined);
}

export async function socketOccupied(path: string): Promise<boolean> {
    const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
    });
    if (entry === undefined) return false;
    if (!entry.isSocket()) return true;
    return await new Promise<boolean>((resolve) => {
        const socket = createConnection(path);
        const timer = setTimeout(() => finish(true), 250);
        const finish = (occupied: boolean): void => {
            clearTimeout(timer);
            socket.destroy();
            resolve(occupied);
        };
        socket.once("connect", () => finish(true));
        socket.once("error", (error: NodeJS.ErrnoException) =>
            finish(error.code !== "ECONNREFUSED" && error.code !== "ENOENT"));
    });
}

export function verifiedWorkerHello(socket: WorkerSocket, hello: WorkerHello, buildId: string): boolean {
    const identity = socket.identity;
    return identity !== undefined && identity.role === "worker" && identity.worker_id === `w${socket.index}`
        && identity.worker_index === socket.index && identity.pid === hello.pid
        && identity.started_at === hello.started_at && identity.build_id === buildId && hello.build_id === buildId
        && hello.id === `w${socket.index}` && hello.index === socket.index && hello.socket === socket.path
        && Number.isSafeInteger(hello.count) && hello.count > socket.index && identity.worker_count === hello.count
        && Number.isSafeInteger(identity.worker_generation) && identity.worker_generation! > 0
        && checkRecordIdentity(hello) === "match";
}

export async function workerCountFromReconnect(
    home: string, sockets: readonly WorkerSocket[], buildId: string,
): Promise<number | undefined> {
    const candidates = sockets.filter((socket) => socket.index >= 0 && socket.identity?.role === "worker"
        && socket.identity.build_id === buildId);
    if (candidates.length === 0) return undefined;
    const control = await startWorkerControlServer(home);
    const count = Promise.withResolvers<number>();
    try {
        for (const socket of candidates) {
            control.register(`w${socket.index}`, async (_peer, hello) => {
                const current = await requestHostIdentity(socket.path);
                if (verifiedWorkerHello({ ...socket, identity: current }, hello, buildId)) count.resolve(hello.count);
                throw new Error("Session process is starting");
            });
        }
        return await Promise.race([count.promise, Bun.sleep(1_000).then(() => undefined)]);
    } finally {
        await control.close();
    }
}
