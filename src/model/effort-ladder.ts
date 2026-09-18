export const EFFORT_LADDER = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
] as const;

export type EffortLevel = typeof EFFORT_LADDER[number];

export type EffortMap = Readonly<Record<string, string | null | undefined>>;

export type RelativeEffort = "lowest" | "equal" | EffortLevel;

export interface CoarsenedEffort {
    readonly level: string;
    readonly providerEffort: string;
}

export function isEffortLevel(value: unknown): value is EffortLevel {
    return typeof value === "string"
        && (EFFORT_LADDER as readonly string[]).includes(value);
}

export function isRelativeEffort(value: unknown): value is RelativeEffort {
    return value === "lowest" || value === "equal" || isEffortLevel(value);
}

export function supportedLevels(efforts: EffortMap): readonly string[] {
    return EFFORT_LADDER.filter((level) => {
        const wire = efforts[level];
        return typeof wire === "string" && wire.length > 0;
    });
}

export function coarsenOneStep(
    requested: string,
    efforts: EffortMap,
    exclude: ReadonlySet<string> = new Set(),
): CoarsenedEffort | undefined {
    const supported = supportedLevels(efforts)
        .filter((level) => level !== requested && !exclude.has(level));
    if (supported.length === 0) {
        return undefined;
    }

    const origin = (EFFORT_LADDER as readonly string[]).indexOf(requested);
    if (origin < 0) {
        return undefined;
    }
    const rank = (level: string): number =>
        (EFFORT_LADDER as readonly string[]).indexOf(level);

    const below = supported.filter((level) => rank(level) < origin);
    const chosen = below.length > 0
        ? below[below.length - 1] as string
        : supported[0] as string;

    return { level: chosen, providerEffort: efforts[chosen] as string };
}

/**
 * Whether a newly chosen model has left the current effort with nothing to
 * mean. Only then is there a question to ask: re-offering a level the model
 * already supports makes the user say "high" twice.
 */
export function effortWentStale(
    available: readonly string[],
    current: string | undefined,
): boolean {
    if (current === undefined) return false;
    return !available.includes(current);
}
