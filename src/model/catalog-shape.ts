/**
 * The pinned on-disk fact shape for the model catalog (nash-50).
 *
 * One record, two sources: `config/models.json` ships with Vera and
 * `~/.vera/cache/<provider>.json` is written by provider discovery. Only the
 * cache carries `fetched_at`. Merging is a field overlay: the provider wins on
 * everything it supplies, Vera's file fills the gaps.
 */

/**
 * The exact string sent to the provider. Not a fixed vocabulary: a level is
 * whatever a given model offers, which is what keeps a model's top level
 * reachable instead of clamped to a hardcoded ceiling.
 */
export type ReasoningLevelId = string;

/**
 * `id` currently means "the string sent as the reasoning parameter". A
 * model controlled by an in-prompt token instead (Qwen3-style `/no_think`)
 * would need a discriminator here saying how the level is applied; no such
 * model exists in Vera today, so that discriminator is not built (nash-52).
 */
export interface ReasoningLevel {
    readonly id: ReasoningLevelId;
    readonly label: string;
    readonly description?: string;
}

export interface CatalogModel {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    /** Lower sorts first. Absent sorts after everything present. */
    readonly order?: number;
    readonly context_window?: number;
    readonly tool_support?: boolean;
    readonly default_level?: ReasoningLevelId;
    /**
     * Ordered most capable first, and every source normalises to that on the
     * way in. There is no way to recover capability order from level ids
     * alone (they are provider words, not a scale), so the order in this list
     * is the only thing that tells a consumer which way is up: it is what
     * makes "step up a level" and "settle on a moderate level" mean the same
     * thing across providers.
     *
     * Empty means the model has no reasoning control at all.
     */
    readonly levels: readonly ReasoningLevel[];
}

export interface ProviderCatalog {
    readonly schema_version: 2;
    readonly provider: string;
    /** Present on discovery snapshots, absent on the shipped file. */
    readonly fetched_at?: string;
    readonly models: readonly CatalogModel[];
}
