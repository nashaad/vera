const UNITS: Record<string, number> = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

// Reads the DIRTY column (third size) of each region type in `vmmap -summary` output.
export function parseVmmapSummary(source: string): Map<string, number> {
    const dirty = new Map<string, number>();
    for (const line of source.split("\n")) {
        const match = line.match(/^(\S.*?)\s{2,}(\S+)\s+(\S+)\s+(\S+)\s/);
        if (match === null) continue;
        const bytes = parseSize(match[4]!);
        if (bytes !== undefined) dirty.set(match[1]!.trim(), bytes);
    }
    return dirty;
}

function parseSize(text: string): number | undefined {
    const match = text.match(/^(\d+(?:\.\d+)?)([KMGT]?)$/);
    if (match === null) return undefined;
    return Math.round(Number(match[1]) * UNITS[match[2]!]!);
}

export interface HeapSample {
    readonly at: number;
    readonly heapUsed: number;
    readonly gcMs: number;
}

// Lines come from dev/soak/heap-preload.ts. A partially written last line is skipped.
export function parseHeapSamples(text: string): HeapSample[] {
    const samples: HeapSample[] = [];
    for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        try {
            const value = JSON.parse(line) as Partial<HeapSample>;
            if (typeof value.at === "number" && typeof value.heapUsed === "number" && typeof value.gcMs === "number") {
                samples.push({ at: value.at, heapUsed: value.heapUsed, gcMs: value.gcMs });
            }
        } catch {
            continue;
        }
    }
    return samples;
}

// Median of the last `count` samples at or before `time`. Each field is medianed on its own.
// Undefined when no sample exists yet.
export function heapMedianBefore(samples: readonly HeapSample[], time: number, count: number): HeapSample | undefined {
    const recent = samples.filter((sample) => sample.at <= time).sort((a, b) => a.at - b.at).slice(-count);
    if (recent.length === 0) return undefined;
    return {
        at: recent[recent.length - 1]!.at,
        heapUsed: median(recent.map((sample) => sample.heapUsed)),
        gcMs: median(recent.map((sample) => sample.gcMs)),
    };
}

function median(values: readonly number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

// Ordinary least squares over [x, y] points. Growth is the fitted rise across the first to last x.
export function leastSquaresSlope(points: readonly (readonly [number, number])[]): { slope: number; growth: number } {
    const n = points.length;
    if (n < 2) return { slope: 0, growth: 0 };
    const meanX = points.reduce((sum, [x]) => sum + x, 0) / n;
    const meanY = points.reduce((sum, [, y]) => sum + y, 0) / n;
    let num = 0;
    let den = 0;
    for (const [x, y] of points) {
        num += (x - meanX) * (y - meanY);
        den += (x - meanX) ** 2;
    }
    const slope = den === 0 ? 0 : num / den;
    const xs = points.map(([x]) => x);
    return { slope, growth: slope * (Math.max(...xs) - Math.min(...xs)) };
}
