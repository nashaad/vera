/**
 * The pinned on-disk fact shape for the model catalog (nash-50).
 *
 * One record, one source: `~/.vera/cache/<provider>.json`, written by provider
 * discovery. Vera shipped a curated file alongside it once; the provider is the
 * authority on its own model list, so the file only ever went stale (nash-58).
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

/**
 * The provider's listed standard token rates, normalized to USD per million
 * tokens. Absent means the source did not publish both rates in a form Vera
 * could read; it never means free. `cache` is the listed cache-hit rate when
 * the source published one; absent means the blend uses the input rate.
 */
export interface ModelPricing {
    readonly input: number;
    readonly output: number;
    readonly cache?: number;
}

export interface CatalogModel {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    /** Lower sorts first. Absent sorts after everything present. */
    readonly order?: number;
    readonly context_window?: number;
    /**
     * When the provider first listed this model, in seconds since the epoch.
     *
     * A listing date, not a release date: a model that existed for a year
     * before it reached this provider dates from the listing. Staleness is the
     * question being asked, so the listing is the more useful of the two, but
     * the two are not the same fact and this field does not claim to be the
     * second one.
     *
     * A model cannot become newer than it already is, so this is resolved once
     * for an id and then kept. `mergeCatalogReleaseDates` holds the first date
     * seen against a later listing that disagrees, which happens when a model
     * is delisted and relisted.
     */
    readonly created?: number;
    readonly tool_support?: boolean;
    /**
     * Whether the model accepts image input, as the provider's own listing
     * describes it. Absent means the listing did not say, which is not the
     * same as no: a consumer that needs a definite answer falls through to
     * what the pool learned from a probe.
     */
    readonly image_support?: boolean;
    readonly pricing?: ModelPricing;
    readonly default_level?: ReasoningLevelId;
    /**
     * True on a model Vera's shipped curation recommends. A flag on the entry
     * rather than a separate list, so the picker's Top picks view is a filter
     * over the one set of model rows and no model can be listed twice.
     */
    readonly recommended?: boolean;
    /** The level the curation recommends this model at. A note, not a gate. */
    readonly recommended_level?: ReasoningLevelId;
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
