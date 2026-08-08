/**
 * Whether a model takes image input, as one lookup for the code that builds a
 * request.
 *
 * Declared over learned over cached catalog, the same order every other reader
 * of capability data uses. Supplied to an adapter as a callback so the
 * provider layer never reads a pool file or a catalog itself, matching how
 * `EffortLevelsLookup` reaches the same layer.
 */

import type { EffectiveCatalogOptions } from "./catalog.ts";
import type { EffortPool } from "./effort-pool.ts";

export interface ImageSupportLookup {
    /**
     * Undefined when nothing knows either way. A caller needing a definite
     * answer treats that as permission to try: a model wrongly refused here
     * never reaches the provider that would have accepted it, while a model
     * wrongly allowed fails with the provider's own reason.
     */
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
