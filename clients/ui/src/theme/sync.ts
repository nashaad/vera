import type { DesktopBridge } from "../protocol/bridge.ts";
import { switchTheme } from "./activate.ts";
import { parseImportedSummaries } from "./imported.ts";
import { importedThemeById, setImportedThemes } from "./imported-registry.ts";
import { readStoredTheme, readThemeCache } from "./storage.ts";
import { DEFAULT_THEME, importedThemeSlug, type ThemeName } from "./tokens.ts";

// The built-in theme the stored imported theme falls back to: its own type, from the loaded list or the page-head cache.
function fallbackType(stored: string): ThemeName {
    const loaded = importedThemeById(stored);
    if (loaded !== undefined) return loaded.type;
    const cached = readThemeCache();
    return cached !== undefined && cached.slug === importedThemeSlug(stored) ? cached.type : DEFAULT_THEME;
}

// Replaces the loaded themes, then applies the stored choice again against them. It picks up colors changed by a
// re-import, and a theme that is gone (removed, or its extension turned off) falls back to the built-in theme of its type.
export function applyThemeList(themes: unknown): void {
    const stored = readStoredTheme();
    const type = importedThemeSlug(stored) === undefined ? undefined : fallbackType(stored);
    setImportedThemes(parseImportedSummaries(themes));
    if (type === undefined) return;
    switchTheme(importedThemeById(stored) === undefined ? type : stored);
}

// Reads the themes the desktop shell offers and applies them. Nothing changes when the shell does not answer.
export async function syncImportedThemes(bridge: DesktopBridge | undefined = globalThis.window?.veraDesktop): Promise<void> {
    if (bridge === undefined) return;
    let themes: unknown;
    try {
        themes = await bridge.loadImportedThemes();
    } catch {
        return;
    }
    applyThemeList(themes);
}
