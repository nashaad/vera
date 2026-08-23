/** Resident memory for a process, sampled from the operating system. */
export interface ProcessMemorySample {
    readonly pid: number;
    readonly rssBytes: number;
}

/** Parse the portable `ps -o pid=,rss=` shape. RSS is reported in KiB. */
export function parseProcessMemory(source: string): ProcessMemorySample[] {
    return source.split("\n").flatMap((line) => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
        if (match === null) return [];
        return [{
            pid: Number(match[1]),
            rssBytes: Number(match[2]) * 1024,
        }];
    });
}

/**
 * Read several process sizes in one bounded OS query.
 *
 * This is diagnostic-only. A process that exits during the sample is simply
 * absent, and a failed probe never affects the client or its session.
 */
export async function readProcessMemory(
    pids: readonly number[],
): Promise<ReadonlyMap<number, number>> {
    const unique = [...new Set(pids.filter((pid) =>
        Number.isSafeInteger(pid) && pid > 0
    ))];
    if (unique.length === 0) return new Map();
    const child = Bun.spawn([
        "ps",
        "-o",
        "pid=,rss=",
        "-p",
        unique.join(","),
    ], { stdout: "pipe", stderr: "ignore" });
    const [exitCode, output] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
    ]);
    if (exitCode !== 0) return new Map();
    return new Map(parseProcessMemory(output).map((sample) =>
        [sample.pid, sample.rssBytes] as const
    ));
}
