/**
 * All models intelligence cutoff: a WA Score floor, not a second score.
 *
 * Six stops on the Any/Smarter numberline. Floors are documented product
 * constants, not percentiles of the current list.
 */

export const INTELLIGENCE_CUTOFFS = [
    "any",
    "1400",
    "1450",
    "1500",
    "1550",
    "1600",
] as const;

export type IntelligenceCutoff = (typeof INTELLIGENCE_CUTOFFS)[number];

export function intelligenceCutoffFloor(
    cutoff: IntelligenceCutoff,
): number | undefined {
    return cutoff === "any" ? undefined : Number(cutoff);
}

export function passesIntelligenceCutoff(
    waScore: number | undefined,
    cutoff: IntelligenceCutoff,
): boolean {
    const floor = intelligenceCutoffFloor(cutoff);
    return floor === undefined || (waScore !== undefined && waScore >= floor);
}

export function stepIntelligenceCutoff(
    cutoff: IntelligenceCutoff,
    direction: -1 | 1,
): IntelligenceCutoff {
    const index = INTELLIGENCE_CUTOFFS.indexOf(cutoff);
    const next = Math.max(
        0,
        Math.min(INTELLIGENCE_CUTOFFS.length - 1, index + direction),
    );
    return INTELLIGENCE_CUTOFFS[next]!;
}
