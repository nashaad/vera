
import type { EffectiveCatalogOptions } from "./catalog.ts";
import type { EffortPool } from "./effort-pool.ts";

export interface ImageSupportLookup {
    (model: string): boolean | undefined;
}

export interface PoolImageSupportOptions extends EffectiveCatalogOptions {
    readonly pool: EffortPool;
    readonly provider: string;
}

export function poolImageSupport(
    options: PoolImageSupportOptions,
): ImageSupportLookup {
    return (model) => options.pool.resolveImageSupport({
        provider: options.provider,
        model,
    });
}
