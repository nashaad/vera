export interface ProcessMemorySample {
    readonly pid: number;
    readonly rssBytes: number;
}

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
