import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";

import { processIsAlive } from "../src/host/process-identity.ts";

export interface DevClientRecord {
    readonly pid: number;
    readonly startedAt: string;
}

export interface DevClientProcessInfo {
    readonly isAlive: (pid: number) => boolean;
    readonly startTime: (pid: number) => string | undefined;
    readonly launchHome: (pid: number) => string | undefined;
    readonly signal: (pid: number, signal: NodeJS.Signals) => void;
    readonly wait?: (ms: number) => Promise<void>;
    readonly graceMs?: number;
}

export function clientRecordPath(home: string): string {
    return join(home, "runtime", "dev-tui-client.json");
}

export function readClientRecord(home: string): DevClientRecord | undefined {
    try {
        const value: unknown = JSON.parse(readFileSync(clientRecordPath(home), "utf8"));
        if (typeof value !== "object" || value === null) return undefined;
        const record = value as Record<string, unknown>;
        if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0
            || typeof record.startedAt !== "string" || record.startedAt.length === 0) return undefined;
        return { pid: record.pid as number, startedAt: record.startedAt };
    } catch {
        return undefined;
    }
}

export function writeClientRecord(home: string, record: DevClientRecord): void {
    const path = clientRecordPath(home);
    mkdirSync(join(home, "runtime"), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    try {
        writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
        renameSync(temporary, path);
    } finally {
        rmSync(temporary, { force: true });
    }
}

export function removeClientRecord(home: string, record?: DevClientRecord): void {
    if (record !== undefined) {
        const current = readClientRecord(home);
        if (current?.pid !== record.pid || current.startedAt !== record.startedAt) return;
    }
    rmSync(clientRecordPath(home), { force: true });
}

export function clientStartTime(pid: number): string | undefined {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
    if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
    return result.stdout.trim().replace(/\s+/g, " ") || undefined;
}

export interface DevClientChild {
    readonly pid: number;
    readonly exited: Promise<number>;
    readonly kill: () => unknown;
}

export async function trackClient(
    home: string,
    child: DevClientChild,
    startTime: (pid: number) => string | undefined = clientStartTime,
): Promise<number> {
    const startedAt = startTime(child.pid);
    if (startedAt === undefined) {
        child.kill();
        await child.exited;
        throw new Error("Could not record the development client start time.");
    }
    const record = { pid: child.pid, startedAt };
    try {
        writeClientRecord(home, record);
    } catch (error) {
        child.kill();
        await child.exited;
        throw error;
    }
    try {
        return await child.exited;
    } finally {
        removeClientRecord(home, record);
    }
}

function macLaunchEnvironment(pid: number): Buffer | undefined {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
        sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    });
    try {
        const mib = new Int32Array([1, 49, pid]);
        const size = new BigUint64Array(1);
        if (library.symbols.sysctl(ptr(mib), 3, null, ptr(size), null, 0) !== 0) return undefined;
        const length = Number(size[0]);
        if (length < 4 || length > 16 * 1024 * 1024) return undefined;
        const data = Buffer.alloc(length);
        if (library.symbols.sysctl(ptr(mib), 3, ptr(data), ptr(size), null, 0) !== 0) return undefined;
        const argc = data.readInt32LE(0);
        if (argc < 0 || argc > 65536) return undefined;
        let offset = data.indexOf(0, 4);
        if (offset < 0) return undefined;
        while (offset < data.length && data[offset] === 0) offset++;
        for (let index = 0; index < argc; index++) {
            offset = data.indexOf(0, offset);
            if (offset < 0) return undefined;
            offset++;
        }
        return data.subarray(offset, Number(size[0]));
    } finally {
        library.close();
    }
}

export function clientLaunchHome(pid: number): string | undefined {
    try {
        const environment = process.platform === "darwin"
            ? macLaunchEnvironment(pid)
            : process.platform === "linux" ? readFileSync(`/proc/${pid}/environ`) : undefined;
        const entry = environment?.toString("utf8").split("\0").find((value) => value.startsWith("VERA_HOME="));
        return entry?.slice("VERA_HOME=".length);
    } catch {
        return undefined;
    }
}

const processInfo: DevClientProcessInfo = {
    isAlive: processIsAlive,
    startTime: clientStartTime,
    launchHome: clientLaunchHome,
    signal: (pid, signal) => process.kill(pid, signal),
};

export async function stopRecordedClient(
    home: string,
    stderr: { write(text: string): unknown },
    info: DevClientProcessInfo = processInfo,
): Promise<number> {
    const record = readClientRecord(home);
    if (record === undefined) {
        removeClientRecord(home);
        return 0;
    }
    const matches = (): boolean => info.isAlive(record.pid)
        && info.startTime(record.pid) === record.startedAt
        && info.launchHome(record.pid) === home;
    if (!matches()) {
        removeClientRecord(home, record);
        return 0;
    }
    const wait = info.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    try {
        info.signal(record.pid, "SIGTERM");
        const deadline = Date.now() + (info.graceMs ?? 3_000);
        while (matches() && Date.now() < deadline) await wait(50);
        if (matches()) {
            info.signal(record.pid, "SIGKILL");
            const killDeadline = Date.now() + (info.graceMs ?? 2_000);
            while (matches() && Date.now() < killDeadline) await wait(50);
            if (matches()) {
                stderr.write(`Development client PID ${record.pid} did not stop.\n`);
                return 1;
            }
        }
        removeClientRecord(home, record);
        return 0;
    } catch (error) {
        if (!info.isAlive(record.pid)) {
            removeClientRecord(home, record);
            return 0;
        }
        stderr.write(`Could not stop development client PID ${record.pid}: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
}
