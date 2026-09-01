import { execFileSync } from "node:child_process";

const START_TIME_TOLERANCE_MS = 10_000;

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
    return ((((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60)
        + Number(minutes)) * 60 + Number(seconds)) * 1_000;
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
    return elapsedMs === undefined ? undefined : Date.now() - elapsedMs;
}

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
