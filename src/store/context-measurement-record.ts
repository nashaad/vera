import {
    isProjectionComponent,
    type ContextMeasurement,
    type ContextProjectionComponent,
} from "../engine/context-measurement.ts";

export const CONTEXT_MEASUREMENT_RECIPE_VERSION = 1;
export const CONTEXT_MEASUREMENT_KEYFRAME_INTERVAL = 128;

export interface ContextMeasurementRecipe {
    readonly version: 1;
    readonly keyframe: boolean;
    readonly append: readonly ContextProjectionComponent[];
    readonly update: readonly (readonly [
        number,
        ContextProjectionComponent,
    ])[];
    readonly truncate?: number;
}

export interface CompactContextMeasurement {
    readonly measurement: ContextMeasurement;
    readonly recipe: ContextMeasurementRecipe;
}

/**
 * Keeps the totals old builds read while a recipe restores the full component
 * list in new builds. The aggregate sums must equal tokens for
 * isContextMeasurement to accept the record.
 */
export function aggregateContextMeasurement(
    measurement: ContextMeasurement,
): ContextMeasurement {
    const projection = measurement.projection;
    if (projection === undefined) return measurement;
    const components: ContextProjectionComponent[] = [];
    for (const kind of ["prompt_contribution", "tool_schema", "message"] as const) {
        const matching = projection.components.filter((component) =>
            component.kind === kind
        );
        if (matching.length === 0) continue;
        components.push({
            kind,
            id: `${kind}:*`,
            owner: kind === "message" ? "session" : "engine",
            source: kind,
            displayName: kind === "prompt_contribution"
                ? "Instructions"
                : kind === "tool_schema"
                ? "Tools"
                : "Messages",
            count: matching.reduce((total, component) => total + component.count, 0),
            estimatedTokens: matching.reduce(
                (total, component) => total + component.estimatedTokens,
                0,
            ),
        });
    }
    return {
        ...measurement,
        projection: {
            estimatedTokens: projection.estimatedTokens,
            components,
        },
    };
}

export function contextMeasurementKeyframe(
    components: readonly ContextProjectionComponent[],
): ContextMeasurementRecipe {
    return {
        version: CONTEXT_MEASUREMENT_RECIPE_VERSION,
        keyframe: true,
        append: components,
        update: [],
    };
}

export function compactContextMeasurement(
    measurement: ContextMeasurement,
    previous: readonly ContextProjectionComponent[] | undefined,
    keyframe: boolean,
): CompactContextMeasurement {
    const components = measurement.projection?.components;
    if (components === undefined) {
        throw new Error("Cannot compact a measurement without a projection");
    }
    const recipe = keyframe || previous === undefined
        ? contextMeasurementKeyframe(components)
        : contextMeasurementDelta(previous, components);
    return {
        measurement: aggregateContextMeasurement(measurement),
        recipe,
    };
}

export function contextMeasurementDelta(
    previous: readonly ContextProjectionComponent[],
    next: readonly ContextProjectionComponent[],
): ContextMeasurementRecipe {
    const shared = Math.min(previous.length, next.length);
    let prefix = 0;
    while (
        prefix < shared
        && sameProjectionComponent(previous[prefix]!, next[prefix]!)
    ) {
        prefix += 1;
    }
    const update: [number, ContextProjectionComponent][] = [];
    for (let index = prefix; index < shared; index += 1) {
        if (!sameProjectionComponent(previous[index]!, next[index]!)) {
            update.push([index, next[index]!]);
        }
    }
    const append = next.length > previous.length
        ? next.slice(previous.length)
        : [];
    return {
        version: CONTEXT_MEASUREMENT_RECIPE_VERSION,
        keyframe: false,
        append,
        update,
        ...(next.length < previous.length ? { truncate: next.length } : {}),
    };
}

export function replaceContextMeasurementDelta(
    previousRecipe: ContextMeasurementRecipe,
    previous: readonly ContextProjectionComponent[],
    next: readonly ContextProjectionComponent[],
): ContextMeasurementRecipe | undefined {
    if (previousRecipe.keyframe) return contextMeasurementKeyframe(next);
    if (previousRecipe.truncate !== undefined
        && next.length > previousRecipe.truncate) return undefined;
    for (const [index] of previousRecipe.update) {
        if (index < next.length
            && !sameProjectionComponent(previous[index]!, next[index]!)) {
            return undefined;
        }
    }
    const baseLength = previousRecipe.truncate
        ?? previous.length - previousRecipe.append.length;
    const retainedLength = Math.min(baseLength, next.length);
    const priorUpdates = new Set(previousRecipe.update.map(([index]) => index));
    const update: [number, ContextProjectionComponent][] = [];
    for (let index = 0; index < retainedLength; index += 1) {
        if (priorUpdates.has(index)
            || !sameProjectionComponent(previous[index]!, next[index]!)) {
            update.push([index, next[index]!]);
        }
    }
    const truncate = previousRecipe.truncate !== undefined || next.length < baseLength
        ? retainedLength
        : undefined;
    return {
        version: CONTEXT_MEASUREMENT_RECIPE_VERSION,
        keyframe: false,
        append: next.slice(retainedLength),
        update,
        ...(truncate === undefined ? {} : { truncate }),
    };
}

/**
 * Returns undefined when the recipe does not fit the base. A keyframe is the
 * only recipe allowed to start without a base.
 */
export function applyContextMeasurementRecipe(
    base: readonly ContextProjectionComponent[] | undefined,
    recipe: ContextMeasurementRecipe,
): readonly ContextProjectionComponent[] | undefined {
    if (recipe.keyframe) return recipe.append;
    if (base === undefined) return undefined;
    const components = base.slice();
    if (recipe.truncate !== undefined) {
        if (recipe.truncate > components.length) return undefined;
        components.length = recipe.truncate;
    }
    for (const [index, component] of recipe.update) {
        if (index >= components.length) return undefined;
        components[index] = component;
    }
    components.push(...recipe.append);
    return components;
}

export function isContextMeasurementRecipe(
    value: unknown,
): value is ContextMeasurementRecipe {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const recipe = value as Record<string, unknown>;
    return recipe.version === CONTEXT_MEASUREMENT_RECIPE_VERSION
        && typeof recipe.keyframe === "boolean"
        && Array.isArray(recipe.append)
        && recipe.append.every(isProjectionComponent)
        && Array.isArray(recipe.update)
        && recipe.update.every((item) =>
            Array.isArray(item)
            && item.length === 2
            && Number.isSafeInteger(item[0])
            && (item[0] as number) >= 0
            && isProjectionComponent(item[1])
        )
        && (recipe.truncate === undefined
            || (Number.isSafeInteger(recipe.truncate)
                && (recipe.truncate as number) >= 0));
}

export function sameProjectionComponent(
    left: ContextProjectionComponent,
    right: ContextProjectionComponent,
): boolean {
    return left.kind === right.kind
        && left.id === right.id
        && left.owner === right.owner
        && left.source === right.source
        && left.displayName === right.displayName
        && left.count === right.count
        && left.estimatedTokens === right.estimatedTokens
        && sameParts(left.parts, right.parts);
}

function sameParts(
    left: ContextProjectionComponent["parts"],
    right: ContextProjectionComponent["parts"],
): boolean {
    if (left === right) return true;
    if (left === undefined || right === undefined || left.length !== right.length) {
        return false;
    }
    for (let index = 0; index < left.length; index += 1) {
        const a = left[index]!;
        const b = right[index]!;
        if (a.id !== b.id
            || a.displayName !== b.displayName
            || a.scope !== b.scope
            || a.bytes !== b.bytes
            || a.estimatedTokens !== b.estimatedTokens
            || a.imported !== b.imported) {
            return false;
        }
    }
    return true;
}
