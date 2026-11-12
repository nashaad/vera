import type { CoveragePhase, CoverageStatus } from "./coverage-data.ts";

export type CoverageFilter = CoverageStatus | "all";

export interface CoverageCounts {
    readonly window: number;
    readonly partial: number;
    readonly terminal: number;
    readonly host: number;
    readonly total: number;
}

export const STATUS_ORDER: readonly CoverageStatus[] = ["window", "partial", "terminal", "host"];

export const STATUS_LABELS: Readonly<Record<CoverageStatus, string>> = {
    window: "In the window",
    partial: "Partly",
    terminal: "Terminal only",
    host: "Not served",
};

export function coverageCounts(phases: readonly CoveragePhase[]): CoverageCounts {
    const counts = { window: 0, partial: 0, terminal: 0, host: 0 };
    for (const phase of phases) {
        for (const item of phase.items) counts[item.status] += 1;
    }
    const total = counts.window + counts.partial + counts.terminal + counts.host;
    return { ...counts, total };
}

// Phases with no items left after the filter are dropped, so every section on the page has rows.
export function filterPhases(phases: readonly CoveragePhase[], filter: CoverageFilter): readonly CoveragePhase[] {
    const kept: CoveragePhase[] = [];
    for (const phase of phases) {
        const items = filter === "all" ? phase.items : phase.items.filter((item) => item.status === filter);
        if (items.length > 0) kept.push({ name: phase.name, items });
    }
    return kept;
}

export function windowPercent(counts: CoverageCounts): number {
    if (counts.total === 0) return 0;
    return Math.round((counts.window / counts.total) * 100);
}

// A segment's width as a percentage of all behaviors; 0 when there are none.
export function segmentPercent(counts: CoverageCounts, status: CoverageStatus): number {
    if (counts.total === 0) return 0;
    return (counts[status] / counts.total) * 100;
}
