import type { ModelTurnSettings } from "../engine/model-settings.ts";
import type { ProviderCatalogState } from "../providers/catalog-state.ts";

export interface HostModelCatalogSettings extends ModelTurnSettings {
    readonly selectionCleared?: boolean;
    readonly providerCatalogs?: readonly ProviderCatalogState[];
}

export function providerCatalogsOf(settings: ModelTurnSettings | undefined): readonly ProviderCatalogState[] | undefined {
    if (settings === undefined || !("providerCatalogs" in settings) || !Array.isArray(settings.providerCatalogs)) return undefined;
    return settings.providerCatalogs.filter((row): row is ProviderCatalogState => typeof row?.id === "string" && typeof row.label === "string"
        && (row.refreshedAt === undefined || typeof row.refreshedAt === "string"));
}

export function modelSelectionCleared(settings: ModelTurnSettings | undefined): boolean {
    return settings !== undefined && "selectionCleared" in settings && settings.selectionCleared === true;
}
