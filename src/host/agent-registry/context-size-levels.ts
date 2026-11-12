export interface ContextSizeLevelTracker {
    observe(
        levels: readonly number[],
        tokens: number,
        capacity: number | undefined,
    ): readonly number[];
}

export function contextFraction(tokens: number, capacity: number | undefined): number {
    if (capacity === undefined || capacity <= 0
        || !Number.isFinite(capacity) || !Number.isFinite(tokens)) {
        return 0;
    }
    return tokens / capacity;
}

export function contextSizeLevelBaseline(
    measurement: { readonly tokens: number; readonly capacity?: number } | undefined,
): number {
    return measurement === undefined
        ? 0
        : contextFraction(measurement.tokens, measurement.capacity);
}

// Fires each level at most once per crossing; a drop below a level re-arms it.
export function createContextSizeLevelTracker(
    initialFraction: number,
): ContextSizeLevelTracker {
    let previous = initialFraction;
    return {
        observe(levels, tokens, capacity) {
            if (capacity === undefined || capacity <= 0
                || !Number.isFinite(capacity) || !Number.isFinite(tokens)) {
                return [];
            }
            const current = tokens / capacity;
            const crossed: number[] = [];
            if (levels.length > 0) {
                for (const level of [...new Set(levels)].sort((left, right) => left - right)) {
                    if (previous < level && level <= current) crossed.push(level);
                }
            }
            previous = current;
            return crossed;
        },
    };
}
