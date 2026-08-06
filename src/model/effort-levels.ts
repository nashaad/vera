/**
 * The model's levels as one lookup, for the code that builds a request.
 *
 * Declared over learned over cached catalog is the order every other reader of
 * effort data uses. This exposes that same answer through the shape
 * `resolveReasoningSelection` already takes, so a request never re-derives a
 * model's levels from a second source.
 */

import { effectiveCatalog, type EffectiveCatalogOptions } from "./catalog.ts";
import { EFFORT_LADDER } from "./effort-ladder.ts";
import type { EffortPool } from "./effort-pool.ts";

export interface ModelEffortLevels {
    /** The model's own level ids, most capable first. */
    readonly supportedEfforts: readonly string[];
    /** The model's own default level, when the catalog names one. */
    readonly defaultLevel?: string;
    /** The wire string per level. */
    readonly providerEfforts: Readonly<Record<string, string>>;
}

export interface EffortLevelsLookup {
    (model: string, requested: string): ModelEffortLevels | undefined;
}

export interface PoolEffortLevelsOptions extends EffectiveCatalogOptions {
    readonly pool: EffortPool;
    readonly provider: string;
}

/**
 * Undefined for a model nothing knows any level for, which is the one case a
 * caller may still fill from elsewhere. A model with levels always answers
 * here, so a live lookup can never contradict what the picker offers.
 */
export function poolEffortLevels(
    options: PoolEffortLevelsOptions,
): EffortLevelsLookup {
    return (model, requested) => {
        const resolved = options.pool.resolveEffort(
            { provider: options.provider, model },
            requested,
        );
        const providerEfforts: Record<string, string> = {};
        const supportedEfforts: string[] = [];
        for (const level of [...EFFORT_LADDER].reverse()) {
            const wire = resolved.efforts[level];
            if (typeof wire === "string" && wire.length > 0) {
                supportedEfforts.push(level);
                providerEfforts[level] = wire;
            }
        }
        if (supportedEfforts.length === 0) {
            return undefined;
        }
        const defaultLevel = effectiveCatalog(options.provider, options)
            .models.find((candidate) => candidate.id === model)
            ?.default_level;
        return {
            supportedEfforts,
            ...(defaultLevel === undefined ? {} : { defaultLevel }),
            providerEfforts,
        };
    };
}
