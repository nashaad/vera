import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { defaultHostSocketPath } from "../lockfile.ts";
import { checkRecordIdentity, processIsAlive } from "../process-identity.ts";
import type { WorkerHello } from "./worker-control.ts";

interface WorkerRecord {
    readonly id: string;
    readonly index: number;
    readonly pid: number;
    readonly started_at: string;
    readonly socket_path: string;
    readonly control_path: string;
    readonly build_id: string;
    readonly master_pid: number;
}

export interface WorkerRecordHandle {
    remove(): Promise<void>;
}

export async function publishWorkerRecord(home: string, hello: WorkerHello, controlPath: string): Promise<WorkerRecordHandle> {
    const directory = join(dirname(defaultHostSocketPath(home)), "workers");
    const path = join(directory, `${hello.id}.json`);
    const record: WorkerRecord = {
        id: hello.id, index: hello.index, pid: hello.pid, started_at: hello.started_at,
        socket_path: hello.socket, control_path: controlPath, build_id: hello.build_id, master_pid: process.pid,
    };
    const contents = `${JSON.stringify(record)}\n`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let file;
    try {
        file = await open(path, "wx", 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const previous = await readFile(path, "utf8");
        const identity = parseIdentity(previous);
        if (identity === undefined || (processIsAlive(identity.pid) && checkRecordIdentity(identity) !== "mismatch")) {
            throw new Error(`Session worker record is still in use: ${path}`);
        }
        if (await readFile(path, "utf8") !== previous) throw new Error(`Session worker record changed: ${path}`);
        await unlink(path);
        file = await open(path, "wx", 0o600);
    }
    try {
        await file.writeFile(contents, "utf8");
        await file.sync();
    } catch (error) {
        await file.close();
        await unlink(path).catch(() => {});
        throw error;
    }
    await file.close();
    return {
        async remove() {
            const current = await readFile(path, "utf8").catch(() => undefined);
            if (current === contents) await unlink(path).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
            });
        },
    };
}

function parseIdentity(contents: string): { readonly pid: number; readonly started_at: string } | undefined {
    try {
        const value: unknown = JSON.parse(contents);
        if (typeof value !== "object" || value === null) return undefined;
        const record = value as Record<string, unknown>;
        return typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0
            && typeof record.started_at === "string" && Number.isFinite(Date.parse(record.started_at))
            ? { pid: record.pid, started_at: record.started_at } : undefined;
    } catch {
        return undefined;
    }
}
