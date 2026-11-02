import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
    checkRecordIdentity,
    processCommandLine,
    processIsAlive,
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

export function listLiveProcessesIn(
    veraHome: string,
    readStartedAt?: (pid: number) => number | undefined,
): LiveProcessRecord[] {
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
        if (!processIsAlive(record.pid)) {
            dropLiveProcessIn(veraHome, record.pid);
            continue;
        }
        // Prune and dev-sweep signal what this lists. An unreadable start time
        // is neither listed nor dropped: the record may still be a live process.
        const identity = checkRecordIdentity(record, readStartedAt);
        if (identity === "mismatch") {
            dropLiveProcessIn(veraHome, record.pid);
            continue;
        }
        if (identity === "unknown") continue;
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

export interface LiveProcessReads {
    readonly isAlive?: (pid: number) => boolean;
    readonly readStartedAt?: (pid: number) => number | undefined;
    readonly readCommand?: (pid: number) => string | undefined;
    readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface ProcessIdentityRecord {
    readonly pid: number;
    readonly started_at: string;
}

// A record as it was when listed. A PID can be reused after that, so the
// command line is kept to compare against the process found at signal time.
export interface ListedProcess<
    Record extends ProcessIdentityRecord = LiveProcessRecord,
> {
    readonly record: Record;
    readonly command: string | undefined;
}

export type ListedProcessState = "same" | "gone" | "replaced" | "unverified";

export type SignalResult =
    | "sent"
    | "not_delivered"
    | Exclude<ListedProcessState, "same">;

export type ListedStopResult =
    | "stopped"
    | "not_delivered"
    | Exclude<ListedProcessState, "same">;

// Take this when the process is listed, before anything is prompted or stopped.
export function claimListedProcess(
    record: LiveProcessRecord,
    reads: LiveProcessReads = {},
): ListedProcess {
    return {
        record,
        command: (reads.readCommand ?? processCommandLine)(record.pid),
    };
}

// "same" needs the start time to match and the command line to be unchanged.
// A command line unreadable when listed leaves the start time to decide.
export function checkListedProcess(
    listed: ListedProcess<ProcessIdentityRecord>,
    reads: LiveProcessReads = {},
): ListedProcessState {
    const { record } = listed;
    if (!(reads.isAlive ?? processIsAlive)(record.pid)) return "gone";
    const readCommand = reads.readCommand ?? processCommandLine;
    const identity = checkRecordIdentity(record, reads.readStartedAt, readCommand);
    if (identity === "mismatch") return "replaced";
    if (identity === "unknown") return "unverified";
    if (listed.command === undefined) return "same";
    const command = readCommand(record.pid);
    if (command === undefined) return "unverified";
    return command === listed.command ? "same" : "replaced";
}

// Checks identity immediately before this one signal; callers sending
// several signals call it once per signal.
export function signalListedProcess(
    listed: ListedProcess<ProcessIdentityRecord>,
    signal: NodeJS.Signals,
    options: { readonly group?: boolean; readonly reads?: LiveProcessReads } = {},
): SignalResult {
    const reads = options.reads ?? {};
    const state = checkListedProcess(listed, reads);
    if (state !== "same") return state;
    const pid = listed.record.pid;
    try {
        (reads.kill ?? defaultKill)(options.group === true ? -pid : pid, signal);
        return "sent";
    } catch {
        return "not_delivered";
    }
}

function defaultKill(pid: number, signal: NodeJS.Signals): void {
    process.kill(pid, signal);
}

// SIGKILLs the group (when asked), then the process itself, checking identity
// before each. "stopped" means at least one signal was delivered.
export function stopListedProcess(
    listed: ListedProcess<ProcessIdentityRecord>,
    options: { readonly group?: boolean; readonly reads?: LiveProcessReads } = {},
): ListedStopResult {
    const targets = options.group === false ? [false] : [true, false];
    let signalled = false;
    for (const group of targets) {
        const result = signalListedProcess(listed, "SIGKILL", {
            group,
            ...(options.reads === undefined ? {} : { reads: options.reads }),
        });
        if (result === "sent") {
            signalled = true;
            continue;
        }
        if (result === "unverified" || result === "gone" || result === "replaced") {
            return signalled ? "stopped" : result;
        }
    }
    return signalled ? "stopped" : "not_delivered";
}

// The board row is dropped unless the process could not be confirmed or signalled.
export function stopListedLiveProcess(
    listed: ListedProcess,
    reads: LiveProcessReads = {},
): ListedStopResult {
    const result = stopListedProcess(listed, { reads });
    if (result === "stopped" || result === "gone" || result === "replaced") {
        dropLiveProcess(listed.record.pid);
    }
    return result;
}

export function skippedProcessLine(
    pid: number,
    result: Exclude<ListedStopResult, "stopped">,
): string {
    switch (result) {
        case "gone":
            return `PID ${pid} had already exited.\n`;
        case "replaced":
            return `PID ${pid} is no longer the process that was listed;`
                + " left it alone.\n";
        case "unverified":
            return `Could not confirm PID ${pid} is still the process that was`
                + " listed; left it running.\n";
        case "not_delivered":
            return `Could not signal PID ${pid}; left it running.\n`;
    }
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
