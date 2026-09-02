
export type ReasoningLevelId = string;

export interface ReasoningLevel {
    readonly id: ReasoningLevelId;
    readonly label: string;
    readonly description?: string;
    /** Provider string when it differs from `id`. Absent means send `id`. */
    readonly wire?: string;
}

export interface ModelPricing {
    readonly input: number;
    readonly output: number;
    readonly cache?: number;
}

export interface CatalogModel {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly order?: number;
    readonly context_window?: number;
    readonly created?: number;
    readonly tool_support?: boolean;
    readonly image_support?: boolean;
    /**
     * Live listing said this model has a thinking control. Used so the
     * settings overlay can name the vocabulary without inventing presence.
     * Absent means unknown; discovery that only wrote levels still counts as
     * presence via a non-empty `levels` list.
     */
    readonly thinking_support?: boolean;
    readonly pricing?: ModelPricing;
    readonly default_level?: ReasoningLevelId;
    readonly recommended?: boolean;
    readonly recommended_level?: ReasoningLevelId;
    readonly levels: readonly ReasoningLevel[];
}

export interface ProviderCatalog {
    readonly schema_version: 2;
    readonly provider: string;
    readonly fetched_at?: string;
    /** Discovery URL this listing was fetched from. Absent on older snapshots. */
    readonly endpoint?: string;
    readonly models: readonly CatalogModel[];
}
