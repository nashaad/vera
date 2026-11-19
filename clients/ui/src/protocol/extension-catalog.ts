import type { ImportedThemeSummary } from "../theme/imported.ts";
import type { ExtensionRefusal } from "./extensions.ts";

// One theme the catalog offers. The catalog is fetched when Discover opens and is not kept after it closes.
export interface CatalogTheme {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    // Five #rrggbb colors: surface, text, accent, success, danger.
    readonly palette: readonly string[];
    // The same version is already installed.
    readonly installed: boolean;
}

// `available` is false when this build names no catalog.
export type CatalogListResult =
    | { readonly ok: true; readonly available: true; readonly themes: readonly CatalogTheme[] }
    | { readonly ok: true; readonly available: false }
    | ExtensionRefusal;

// A downloaded, checked and unpacked package waiting to be installed.
export interface CatalogPreview {
    // Names the package in `installDesktopExtension` and `cancelDesktopExtension`.
    readonly token: string;
    readonly id: string;
    readonly name: string;
    readonly version: string;
    // The installed version this package would replace.
    readonly replaces?: string;
    // The package's themes keyed as the picker knows them; the page previews the first.
    readonly themes: readonly ImportedThemeSummary[];
}

export type CatalogPreviewResult =
    | { readonly ok: true; readonly preview: CatalogPreview }
    | ExtensionRefusal;
