import type { DesktopBridge } from "../protocol/bridge.ts";
import type { CatalogListResult, CatalogPreviewResult } from "../protocol/extension-catalog.ts";
import { activateTheme } from "../theme/activate.ts";
import { importedThemes, setImportedThemes } from "../theme/imported-registry.ts";
import type { ImportedThemeSummary } from "../theme/imported.ts";
import { readStoredTheme } from "../theme/storage.ts";
import { importedThemeId, type ThemeChoice } from "../theme/tokens.ts";

export const CATALOG_UNREACHABLE = "Vera could not reach the catalog.";
export const DOWNLOAD_FAILED = "Vera could not download that package.";

export async function readCatalog(bridge: DesktopBridge): Promise<CatalogListResult> {
    try {
        return await bridge.openExtensionCatalog();
    } catch {
        return { ok: false, reason: CATALOG_UNREACHABLE };
    }
}

export async function previewCatalogTheme(bridge: DesktopBridge, id: string): Promise<CatalogPreviewResult> {
    try {
        return await bridge.previewCatalogTheme(id);
    } catch {
        return { ok: false, reason: DOWNLOAD_FAILED };
    }
}

// What the window showed before a preview, so Cancel can put it back.
export interface ThemeSnapshot {
    readonly themes: readonly ImportedThemeSummary[];
    readonly stored: ThemeChoice;
}

export function snapshotTheme(): ThemeSnapshot {
    return { themes: importedThemes(), stored: readStoredTheme() };
}

// Applies a theme to the window without storing it; the stored choice stays what it was.
export function showPreview(theme: ImportedThemeSummary, before: ThemeSnapshot): void {
    setImportedThemes([...before.themes.filter((known) => known.slug !== theme.slug), theme]);
    activateTheme(importedThemeId(theme.slug));
}

export function restoreSnapshot(before: ThemeSnapshot): void {
    setImportedThemes(before.themes);
    activateTheme(before.stored);
}
