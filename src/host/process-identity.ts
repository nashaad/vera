import { execFileSync } from "node:child_process";

/**
 * How far the start time the OS reports for a pid may sit from the one the
 * host recorded. The record is derived from `process.uptime()` in
 * milliseconds while `ps` reports whole seconds, so they never match exactly.
 */
const START_TIME_TOLERANCE_MS = 10_000;

/** Whether a pid has a live process. EPERM means alive and owned elsewhere. */
export function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

/**
 * Elapsed time as `ps` prints it, in milliseconds: `[[dd-]hh:]mm:ss`.
 * Undefined when the shape is not that.
 *
 * Elapsed time rather than a start timestamp on purpose. `ps -o lstart` prints
 * local time with no zone, so reading it back depends on the reader's TZ
 * matching the system's; under `TZ=UTC` every start time lands hours off and
 * every live host reads as a stranger. An interval has no such ambiguity.
 */
export function parseElapsedTime(value: string): number | undefined {
    const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());
    if (match === null) return undefined;
    const [, days, hours, minutes, seconds] = match;
    return ((((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60)
        + Number(minutes)) * 60 + Number(seconds)) * 1_000;
}

/**
 * When the OS reports a pid started, in epoch milliseconds. Undefined when the
 * process is gone or the platform will not say.
 */
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
    return elapsedMs === undefined ? undefined : Date.now() - elapsedMs;
}

/**
 * Whether the pid in a lock record still belongs to the process that wrote it.
 * A record outlives its host when the host is killed or the machine loses
 * power, and the pid is then free to be reused by something unrelated. Every
 * path that signals a recorded pid asks this first.
 *
 * Answers true when the start time cannot be read, because that is an unknown
 * rather than evidence of reuse: the caller has already established that the
 * pid is alive and that the record names it.
 */
export function recordMatchesRunningProcess(
    record: { readonly pid: number; readonly started_at: string },
    lookup: (pid: number) => number | undefined = processStartedAt,
): boolean {
    const startedAt = lookup(record.pid);
    if (startedAt === undefined) return true;
    const recorded = Date.parse(record.started_at);
    if (Number.isNaN(recorded)) return true;
    return Math.abs(startedAt - recorded) <= START_TIME_TOLERANCE_MS;
}
