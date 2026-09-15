export type SourceCategory = "agents" | "skills" | "instructions" | "memory" | "extensions";

export interface CustomizationSource {
    readonly id: string;
    readonly category: SourceCategory;
    readonly name: string;
    readonly description: string;
    readonly scope: string;
    readonly path?: string;
    readonly content: string;
    readonly editable: boolean;
    readonly contextIds: readonly string[];
    readonly status?: string;
}

export interface CustomizationCatalog {
    readonly sources: readonly CustomizationSource[];
    readonly warnings: readonly string[];
}
