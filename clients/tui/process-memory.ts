export interface ProcessMemorySample {
    readonly pid: number;
    readonly memoryBytes: number;
}

export function parseProcessMemory(source: string): ProcessMemorySample[] {
    return source.split("\n").flatMap((line) => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
        if (match === null) return [];
        return [{
            pid: Number(match[1]),
            memoryBytes: Number(match[2]) * 1024,
        }];
    });
}

// RSS counts memory the allocator already freed but has not returned to the
// OS, so on macOS it can read twice what Activity Monitor shows.
export function parseFootprint(source: string): ProcessMemorySample[] {
    const samples: ProcessMemorySample[] = [];
    let pid: number | undefined;
    for (const line of source.split("\n")) {
        const header = line.match(/\[(\d+)\]:/);
        if (header !== null) {
            pid = Number(header[1]);
            continue;
        }
        const footprint = line.match(/^\s*phys_footprint:\s+(\d+)\s+B\s*$/);
        if (footprint !== null && pid !== undefined) {
            samples.push({ pid, memoryBytes: Number(footprint[1]) });
            pid = undefined;
        }
    }
    return samples;
}

export async function readProcessMemory(
    pids: readonly number[],
    platform: NodeJS.Platform = process.platform,
): Promise<ReadonlyMap<number, number>> {
    const unique = [...new Set(pids.filter((pid) =>
        Number.isSafeInteger(pid) && pid > 0
    ))];
    if (unique.length === 0) return new Map();
    if (platform === "darwin") {
        const output = await runSampler([
            "footprint",
            "-f",
            "bytes",
            "--noCategories",
            ...unique.map(String),
        ]);
        const samples = output === undefined ? [] : parseFootprint(output);
        if (samples.length > 0) return sampleMap(samples);
    }
    const output = await runSampler([
        "ps",
        "-o",
        "pid=,rss=",
        "-p",
        unique.join(","),
    ]);
    return output === undefined
        ? new Map()
        : sampleMap(parseProcessMemory(output));
}

async function runSampler(
    command: readonly string[],
): Promise<string | undefined> {
    try {
        const child = Bun.spawn([...command], {
            stdout: "pipe",
            stderr: "ignore",
        });
        const [exitCode, output] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
        ]);
        return exitCode === 0 ? output : undefined;
    } catch {
        return undefined;
    }
}

function sampleMap(
    samples: readonly ProcessMemorySample[],
): ReadonlyMap<number, number> {
    return new Map(samples.map((sample) =>
        [sample.pid, sample.memoryBytes] as const
    ));
}
