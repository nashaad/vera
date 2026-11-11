import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const START_TIME_TOLERANCE_MS = 10_000;

export function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

export function parseElapsedTime(value: string): number | undefined {
    const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());
    if (match === null) return undefined;
    const [, days, hours, minutes, seconds] = match;
    if (Number(minutes) > 59 || Number(seconds) > 59) return undefined;
    if (hours !== undefined && Number(hours) > 23) return undefined;
    const elapsedMs = ((((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60)
        + Number(minutes)) * 60 + Number(seconds)) * 1_000;
    return Number.isFinite(elapsedMs) ? elapsedMs : undefined;
}

export function processStartedAt(pid: number): number | undefined {
    let output: string;
    try {
        output = execFileSync("ps", ["-p", String(pid), "-o", "etime="], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
    } catch {
        return undefined;
    }
    const elapsedMs = parseElapsedTime(output);
    if (elapsedMs === undefined) return undefined;
    const startedAt = Date.now() - elapsedMs;
    return startedAt >= 0 ? startedAt : undefined;
}

export function processCommandLine(pid: number): string | undefined {
    let output: string;
    try {
        // -ww: a truncated line could drop the entry path that marks a host.
        output = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
    } catch {
        return undefined;
    }
    const command = output.trim();
    return command.length > 0 ? command : undefined;
}

export type VeraProcessKind =
    | "host"
    | "client"
    | "watchdog"
    | "worker"
    | "supervisor"
    | "test_fixture";

export function classifyVeraProcess(command: string): VeraProcessKind | undefined {
    const role = /(?:^|\s)--vera-role=(host|cli|tui|watchdog|worker|session-worker|supervisor)(?:\s|$)/.exec(command)?.[1];
    if (role === "host" || role === "watchdog" || role === "supervisor") return role;
    if (role === "cli" || role === "tui") return "client";
    if (role === "worker" || role === "session-worker") return "worker";
    if (/(?:^|\s)(?:\S*\/)?(?:clients\/host\/main\.ts|bundle\/clients\/host\/main\.js)(?:\s|$)/.test(command)) {
        return "host";
    }
    if (/(?:^|\s)(?:\S*\/)?(?:clients\/tui\/flight-watchdog\.ts|bundle\/clients\/tui\/flight-watchdog\.js)(?:\s|$)/.test(
        command,
    )) {
        return "watchdog";
    }
    if (
        /(?:^|\s)\S*\/\.bun\/bin\/vera(?:\s|$)/.test(command)
        || /(?:^|\s)(?:\S*\/)?(?:clients\/(?:cli|tui)\/main\.ts|bundle\/clients\/cli\/main\.js)(?:\s|$)/.test(
            command,
        )
    ) {
        return "client";
    }
    if (/(?:^|\s)(?:\S*\/)?(?:src\/host\/worker-supervisor\.ts|bundle\/src\/host\/worker-supervisor\.js)(?:\s|$)/.test(
        command,
    )) {
        return "supervisor";
    }
    if (/(?:^|\s)(?:\S*\/)?(?:src\/host\/worker\/entry\.ts|bundle\/src\/host\/worker\/entry\.js)(?:\s|$)/.test(command)) {
        return "worker";
    }
    if (/(?:^|\s)(?:\S*\/)?(?:clients\/host\/session-worker\.ts|bundle\/clients\/host\/session-worker\.js)(?:\s|$)/.test(command)) {
        return "worker";
    }
    if (
        /(?:^|\s)(?:\S*\/)?test\/support\/\S+-(?:child|resident-host)\.ts(?:\s|$)/
            .test(command)
    ) {
        return "test_fixture";
    }
    return undefined;
}

export type RecordIdentity = "match" | "mismatch" | "unknown";

/** "unknown" means the start time could not be measured. Never signal on it. */
// Linux kernel boot id and the process start tick: exact, and unaffected by wall clock jumps such as WSL2 resuming from sleep.
export function processStartStamp(pid: number): string | undefined {
    if (process.platform !== "linux") return undefined;
    try {
        const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
        if (boot.length === 0 || ticks === undefined || !/^\d+$/.test(ticks)) return undefined;
        return `${boot}:${ticks}`;
    } catch {
        return undefined;
    }
}

export function checkRecordIdentity(
    record: { readonly pid: number; readonly started_at: string; readonly start_stamp?: string },
    lookup: (pid: number) => number | undefined = processStartedAt,
    readCommand: (pid: number) => string | undefined = processCommandLine,
): RecordIdentity {
    // A recorded stamp decides on its own when this OS can read one; injected readers keep the time comparison.
    if (record.start_stamp !== undefined && lookup === processStartedAt) {
        const stamp = processStartStamp(record.pid);
        if (stamp !== undefined) return stamp === record.start_stamp ? "match" : "mismatch";
    }
    const startedAt = lookup(record.pid);
    if (startedAt === undefined || Number.isNaN(new Date(startedAt).getTime())) {
        return "unknown";
    }
    const recorded = Date.parse(record.started_at);
    if (Number.isNaN(recorded)) {
        // With no recorded start time, the command line can only rule a
        // process out. A mismatch here must never lead to a signal.
        const command = readCommand(record.pid);
        return command !== undefined && classifyVeraProcess(command) === undefined
            ? "mismatch"
            : "unknown";
    }
    return Math.abs(startedAt - recorded) <= START_TIME_TOLERANCE_MS
        ? "match"
        : "mismatch";
}
