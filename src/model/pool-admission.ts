/**
 * Admitting a model to the pool: the catalog copy, with no call on the wire.
 *
 * Adding a model never waits on a provider. A model the catalog describes
 * enters with that description copied into its entry; a model the catalog has
 * never heard of enters with safe defaults. Either way it is usable straight
 * away and carries no learned facts, which is what marks it unverified. The
 * probe is the escalation tool (verify on demand, or lazily on the first
 * capability error), not the gate.
 *
 * The copied map lands in the declared half of the entry, because the user
 * asked for this model and the catalog is what Vera knows about it. Only
 * probes and live rejections write `learned`.
 */

import type { CatalogModel } from "./catalog-shape.ts";
import { isEffortLevel } from "./effort-ladder.ts";
import type { PoolFileModel } from "./pool-file.ts";

/**
 * The declared entry a `pool_add` writes.
 *
 * Levels the ladder does not name are dropped rather than copied: a level
 * Vera cannot address is a level it can never ask for or coarsen through, and
 * carrying the word into the pool only lets it reach a provider unchecked.
 * `tools` is copied only when the catalog states it; absent means unknown, and
 * an unknown that reads as `false` would keep the model out of every ladder.
 */
export function declaredPoolEntry(
    catalogModel: CatalogModel | undefined,
): PoolFileModel {
    if (catalogModel === undefined) {
        return { added: true };
    }
    const efforts: Record<string, string> = {};
    for (const level of catalogModel.levels) {
        const rung = level.id === "none" ? "off" : level.id;
        if (isEffortLevel(rung)) {
            efforts[rung] = level.id;
        }
    }
    return {
        added: true,
        ...(catalogModel.tool_support === undefined
            ? {}
            : { tools: catalogModel.tool_support }),
        ...(catalogModel.context_window === undefined
            ? {}
            : { context: catalogModel.context_window }),
        ...(Object.keys(efforts).length === 0 ? {} : { efforts }),
    };
}
