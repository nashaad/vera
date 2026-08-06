/**
 * The fixed effort ladder, coarsest-thinking last.
 *
 * `off` is its own level, not an alias of `minimal`: it means "do not request
 * thinking at all". `minimal` is the smallest nonzero amount. A model that
 * cannot turn thinking off declares `"off": null` and coarsens like any other
 * unsupported level.
 */
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

/**
 * A model's effort map, as stored in the pool file.
 *
 * - a string value is the exact provider wire string for that level
 * - `null` forbids the level: the provider is known to reject it
 * - a missing key says nothing, so it is never a coarsening target
 */
export type EffortMap = Readonly<Record<string, string | null | undefined>>;

/** What a subagent default or self rung asks for, relative to the session. */
export type RelativeEffort = "lowest" | "equal" | EffortLevel;

export interface CoarsenedEffort {
    /** The vera-side level to ask for instead. */
    readonly level: string;
    /** The exact string to put on the wire for that level. */
    readonly providerEffort: string;
}

export function isEffortLevel(value: unknown): value is EffortLevel {
    return typeof value === "string"
        && (EFFORT_LADDER as readonly string[]).includes(value);
}

export function isRelativeEffort(value: unknown): value is RelativeEffort {
    return value === "lowest" || value === "equal" || isEffortLevel(value);
}

/** The declared, non-forbidden levels of a model, in ladder order. */
export function supportedLevels(efforts: EffortMap): readonly string[] {
    return EFFORT_LADDER.filter((level) => {
        const wire = efforts[level];
        return typeof wire === "string" && wire.length > 0;
    });
}

/**
 * Picks the nearest supported neighbour of `requested`, preferring less
 * thinking.
 *
 * "One step" is one step along the model's own supported levels, not along the
 * full ladder: a model declaring `low` and `high` steps `high` to `low` in one
 * move. The search runs downward first because degrading should not silently
 * spend more of the user's money and latency than was asked for; it turns
 * upward only when nothing below is supported, which is the case a forbidden
 * `off` lands in.
 *
 * `exclude` carries the levels already rejected in this turn, so repeated
 * coarsening walks the ladder instead of re-offering a level that just failed.
 */
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
        // A level outside the ladder has no position to descend from. Picking
        // one anyway would land on a level the user never asked for, and the
        // cheapest wrong guess (the top) is the most expensive to run.
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
