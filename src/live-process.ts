import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
    processIsAlive,
    recordMatchesRunningProcess,
} from "./host/process-identity.ts";
import { veraMachineDirectory, veraRuntimeDirectory } from "./profile-paths.ts";

/**
 * What a Vera-owned process calls itself in `ps` and on the live board.
 * Tools never get these names: only the processes Vera itself starts.
 */
export const LIVE_PROCESS_ARGV0 = {
    host: "vera-host",
    tui: "vera-tui",
    worker: "vera-worker",
    supervisor: "vera-supervisor",
    watchdog: "vera-watchdog",
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

/** One file per live pid, under this Vera home's machine tier. */
export function liveProcessDirectory(home?: string): string {
    return join(veraMachineDirectory(home), "live");
}

export function liveProcessPath(pid: number, home?: string): string {
    return join(liveProcessDirectory(home), `${pid}.json`);
}

/**
 * Posts this process onto the board. Call from host, TUI, worker, supervisor,
 * and watchdog mains only — never from a tool the worker spawned.
 */
export function postLiveProcess(
    kind: LiveProcessKind,
    options: {
        readonly pid?: number;
        readonly startedAt?: string;
        readonly runtimeDir?: string;
        readonly home?: string;
    } = {},
): LiveProcessRecord {
    const record: LiveProcessRecord = {
        schema_version: LIVE_PROCESS_SCHEMA_VERSION,
        pid: options.pid ?? process.pid,
        kind,
        // Same clock as host.json: OS start, not post time. A host can take
        // longer than the pid-reuse window to become ready; posting "now"
        // would make prune treat the live pid as a stranger and drop it.
        started_at: options.startedAt
            ?? new Date(Date.now() - process.uptime() * 1_000).toISOString(),
        runtime_dir: options.runtimeDir ?? veraRuntimeDirectory(),
    };
    const directory = liveProcessDirectory(options.home);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
        liveProcessPath(record.pid, options.home),
        `${JSON.stringify(record)}\n`,
        { encoding: "utf8", mode: 0o600 },
    );
    return record;
}

export function dropLiveProcess(pid = process.pid, home?: string): void {
    try {
        unlinkSync(liveProcessPath(pid, home));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

/**
 * Sets the process title, posts, and unlinks on exit. Returns a disposer for
 * tests and for prune after a kill.
 */
export function installLiveProcess(kind: LiveProcessKind): () => void {
    process.title = LIVE_PROCESS_ARGV0[kind];
    postLiveProcess(kind);
    const drop = (): void => {
        dropLiveProcess();
    };
    process.once("exit", drop);
    return () => {
        process.off("exit", drop);
        drop();
    };
}

/**
 * Live posts whose pid is still the process that wrote them. Dead rows are
 * unlinked. This is what `vera prune` lists.
 */
export function listLiveProcesses(home?: string): LiveProcessRecord[] {
    let names: string[];
    try {
        names = readdirSync(liveProcessDirectory(home));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
    const records: LiveProcessRecord[] = [];
    for (const name of names) {
        if (!/^\d+\.json$/.test(name)) continue;
        const path = join(liveProcessDirectory(home), name);
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
            dropLiveProcess(record.pid, home);
            continue;
        }
        records.push(record);
    }
    return records.sort((left, right) =>
        kindOrder(left.kind) - kindOrder(right.kind) || left.pid - right.pid
    );
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
        // Not a group leader, or already gone.
    }
    try {
        process.kill(pid, "SIGKILL");
        signaled = true;
    } catch {
        // Already gone.
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
