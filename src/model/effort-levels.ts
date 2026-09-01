
import { effectiveCatalog, type EffectiveCatalogOptions } from "./catalog.ts";
import { EFFORT_LADDER } from "./effort-ladder.ts";
import type { EffortPool } from "./effort-pool.ts";

export interface ModelEffortLevels {
    readonly supportedEfforts: readonly string[];
    readonly defaultLevel?: string;
    readonly providerEfforts: Readonly<Record<string, string>>;
}

export interface EffortLevelsLookup {
    (model: string, requested: string): ModelEffortLevels | undefined;
}

export interface PoolEffortLevelsOptions extends EffectiveCatalogOptions {
    readonly pool: EffortPool;
    readonly provider: string;
}

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
