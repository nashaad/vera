import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
    processIsAlive,
    recordMatchesRunningProcess,
} from "./host/process-identity.ts";
import {
    veraHomeDirectory,
    veraMachineDirectoryIn,
    veraRuntimeDirectory,
} from "./profile-paths.ts";

export const LIVE_PROCESS_ARGV0 = {
    host: "vera-host",
    tui: "vera-tui",
    worker: "vera-worker",
    supervisor: "vera-supervisor",
    watchdog: "vera-watchdog",
    annex: "vera-annex",
} as const;

export type LiveProcessKind = keyof typeof LIVE_PROCESS_ARGV0;

export interface LiveProcessRecord {
    readonly schema_version: 1;
    readonly pid: number;
    readonly kind: LiveProcessKind;
    readonly started_at: string;
    readonly runtime_dir: string;
}

export const LIVE_PROCESS_SCHEMA_VERSION = 1 as const;

/**
 * The `home` arguments below name the user's home, the way `veraHomeDirectory`
 * reads them. The `In` forms name a Vera home outright, which is what a caller
 * holding a path to some other Vera has.
 */
export function liveProcessDirectoryIn(veraHome: string): string {
    return join(veraMachineDirectoryIn(veraHome), "live");
}

export function liveProcessDirectory(home?: string): string {
    return liveProcessDirectoryIn(veraHomeDirectory(home));
}

export function liveProcessPath(pid: number, home?: string): string {
    return join(liveProcessDirectory(home), `${pid}.json`);
}

export function postLiveProcessIn(
    veraHome: string,
    kind: LiveProcessKind,
    options: {
        readonly pid?: number;
        readonly startedAt?: string;
        readonly runtimeDir?: string;
    } = {},
): LiveProcessRecord {
    const record: LiveProcessRecord = {
        schema_version: LIVE_PROCESS_SCHEMA_VERSION,
        pid: options.pid ?? process.pid,
        kind,
        started_at: options.startedAt
            ?? new Date(Date.now() - process.uptime() * 1_000).toISOString(),
        runtime_dir: options.runtimeDir ?? veraRuntimeDirectory(),
    };
    const directory = liveProcessDirectoryIn(veraHome);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
        join(directory, `${record.pid}.json`),
        `${JSON.stringify(record)}\n`,
        { encoding: "utf8", mode: 0o600 },
    );
    return record;
}

export function postLiveProcess(
    kind: LiveProcessKind,
    options: {
        readonly pid?: number;
        readonly startedAt?: string;
        readonly runtimeDir?: string;
        readonly home?: string;
    } = {},
): LiveProcessRecord {
    return postLiveProcessIn(veraHomeDirectory(options.home), kind, options);
}

export function dropLiveProcessIn(veraHome: string, pid: number): void {
    try {
        unlinkSync(join(liveProcessDirectoryIn(veraHome), `${pid}.json`));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

export function dropLiveProcess(pid = process.pid, home?: string): void {
    dropLiveProcessIn(veraHomeDirectory(home), pid);
}

export function installLiveProcess(
    kind: LiveProcessKind,
    veraHome = veraHomeDirectory(),
): () => void {
    process.title = LIVE_PROCESS_ARGV0[kind];
    postLiveProcessIn(veraHome, kind);
    const drop = (): void => {
        dropLiveProcessIn(veraHome, process.pid);
    };
    process.once("exit", drop);
    return () => {
        process.off("exit", drop);
        drop();
    };
}

export function listLiveProcessesIn(veraHome: string): LiveProcessRecord[] {
    const directory = liveProcessDirectoryIn(veraHome);
    let names: string[];
    try {
        names = readdirSync(directory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
    const records: LiveProcessRecord[] = [];
    for (const name of names) {
        if (!/^\d+\.json$/.test(name)) continue;
        const path = join(directory, name);
        const record = readLiveProcessFile(path);
        if (record === undefined) {
            try {
                unlinkSync(path);
            } catch {
                // A unreadable file must not block the rest of the board.
            }
            continue;
        }
        if (!processIsAlive(record.pid) || !recordMatchesRunningProcess(record)) {
            dropLiveProcessIn(veraHome, record.pid);
            continue;
        }
        records.push(record);
    }
    return records.sort((left, right) =>
        kindOrder(left.kind) - kindOrder(right.kind) || left.pid - right.pid
    );
}

export function listLiveProcesses(home?: string): LiveProcessRecord[] {
    return listLiveProcessesIn(veraHomeDirectory(home));
}

export function renderVeraPrune(
    records: readonly LiveProcessRecord[],
    currentHostPid?: number,
): string {
    const lines = [
        "Vera prune",
        "",
    ];
    if (records.length === 0) {
        lines.push("No Vera processes listed.");
        return `${lines.join("\n")}\n`;
    }
    for (const record of records) {
        const current = record.pid === currentHostPid
            ? "  current host for this shell"
            : "";
        lines.push(
            `  PID ${record.pid}  ${record.kind.padEnd(12)}  ${record.runtime_dir}${current}`,
        );
    }
    return `${lines.join("\n")}\n`;
}

export function stopLivePid(pid: number): boolean {
    let signaled = false;
    try {
        process.kill(-pid, "SIGKILL");
        signaled = true;
    } catch {
    }
    try {
        process.kill(pid, "SIGKILL");
        signaled = true;
    } catch {
    }
    dropLiveProcess(pid);
    return signaled;
}

function readLiveProcessFile(path: string): LiveProcessRecord | undefined {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch {
        return undefined;
    }
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Partial<LiveProcessRecord>;
    if (record.schema_version !== LIVE_PROCESS_SCHEMA_VERSION) return undefined;
    if (!Number.isInteger(record.pid) || record.pid === undefined) return undefined;
    if (!isLiveProcessKind(record.kind)) return undefined;
    if (typeof record.started_at !== "string" || record.started_at.length === 0) {
        return undefined;
    }
    if (typeof record.runtime_dir !== "string" || record.runtime_dir.length === 0) {
        return undefined;
    }
    return {
        schema_version: LIVE_PROCESS_SCHEMA_VERSION,
        pid: record.pid,
        kind: record.kind,
        started_at: record.started_at,
        runtime_dir: record.runtime_dir,
    };
}

function isLiveProcessKind(value: unknown): value is LiveProcessKind {
    return typeof value === "string" && value in LIVE_PROCESS_ARGV0;
}

function kindOrder(kind: LiveProcessKind): number {
    if (kind === "host") return 0;
    if (kind === "tui") return 1;
    if (kind === "watchdog") return 2;
    if (kind === "worker") return 3;
    return 4;
}
