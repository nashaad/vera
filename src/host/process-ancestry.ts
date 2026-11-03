import { spawnSync } from "node:child_process";

// "  PID  PPID", tolerant of leading whitespace from ps's column padding.
const PID_LINE = /^\s*(\d+)\s+(\d+)\s*$/;

export interface ProcessAncestryOptions {
    // Returns the whole process table as `ps -A -o pid=,ppid=` would, or
    // undefined when it could not be read. Injectable for tests.
    readonly listProcesses?: () => string | undefined;
    readonly currentPid?: number;
}

function defaultProcessList(): string | undefined {
    const result = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
    if (result.error !== undefined || result.status !== 0) return undefined;
    return result.stdout;
}

function parsePpidMap(raw: string): Map<number, number> {
    const map = new Map<number, number>();
    for (const line of raw.split("\n")) {
        const match = PID_LINE.exec(line);
        if (match === null) continue;
        map.set(Number(match[1]), Number(match[2]));
    }
    return map;
}

// Walks this process's parent chain looking for targetPid. Undefined means
// the process table could not be read, not that targetPid is absent from it:
// callers that only guard a known mistake should proceed as if it were absent.
export function targetPidIsAncestor(
    targetPid: number,
    options: ProcessAncestryOptions = {},
): boolean | undefined {
    const raw = (options.listProcesses ?? defaultProcessList)();
    if (raw === undefined) return undefined;
    const ppidOf = parsePpidMap(raw);
    let pid = options.currentPid ?? process.pid;
    const visited = new Set<number>([pid]);
    for (;;) {
        const parent = ppidOf.get(pid);
        if (parent === undefined || parent <= 0 || parent === pid) return false;
        if (parent === targetPid) return true;
        if (visited.has(parent)) return false; // a ps glitch looping back on itself
        visited.add(parent);
        pid = parent;
    }
}
