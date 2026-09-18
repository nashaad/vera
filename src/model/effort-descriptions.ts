import { EFFORT_LADDER } from "./effort-ladder.ts";
import type { ReasoningLevel } from "./catalog-shape.ts";

/**
 * What a level costs, in the only terms we can state for every provider.
 * Vera sends effort as a wire string, never a token budget, so a number here
 * would be invented for all but the provider that happened to publish one.
 */
const LADDER_DESCRIPTIONS: Readonly<Record<string, string>> = {
    off: "No reasoning. Fastest and cheapest.",
    minimal: "Barely any reasoning.",
    low: "A little reasoning.",
    medium: "Moderate reasoning.",
    high: "Deep reasoning.",
    xhigh: "Deeper reasoning. Slower, costs more.",
    max: "As deep as the model goes. Slowest, costs most.",
};

/** A provider's own wording wins; the ladder covers the rest. */
export function effortDescription(level: ReasoningLevel): string | undefined {
    if (level.description !== undefined && level.description.length > 0) {
        return level.description;
    }
    return LADDER_DESCRIPTIONS[level.id];
}

export function effortLevelDescription(id: string): string | undefined {
    return LADDER_DESCRIPTIONS[id];
}

export function describedLevel(level: ReasoningLevel): ReasoningLevel {
    const description = effortDescription(level);
    return description === undefined ? level : { ...level, description };
}

export function describedLevels(
    levels: readonly ReasoningLevel[],
): readonly ReasoningLevel[] {
    return levels.map(describedLevel);
}

/** Every ladder rung carries wording, so no level renders bare. */
export function ladderIsDescribed(): boolean {
    return EFFORT_LADDER.every((level) => LADDER_DESCRIPTIONS[level] !== undefined);
}
