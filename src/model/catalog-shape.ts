
export type ReasoningLevelId = string;

export interface ReasoningLevel {
    readonly id: ReasoningLevelId;
    readonly label: string;
    readonly description?: string;
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
    readonly models: readonly CatalogModel[];
}
