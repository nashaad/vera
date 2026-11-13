import type { DesktopBridge } from "../protocol/bridge.ts";
import { switchTheme } from "./activate.ts";
import { parseImportedSummaries } from "./imported.ts";
import { setImportedThemes } from "./imported-registry.ts";
import { readStoredTheme } from "./storage.ts";
import { isImportedThemeId } from "./tokens.ts";

// Reads the imported themes saved under the home. The stored choice is applied again against them: it picks up colors
// changed by a re-import, and falls back to the default when its file is gone.
export async function syncImportedThemes(bridge: DesktopBridge | undefined = globalThis.window?.veraDesktop): Promise<void> {
    if (bridge === undefined) return;
    let themes: unknown;
    try {
        themes = await bridge.loadImportedThemes();
    } catch {
        return;
    }
    setImportedThemes(parseImportedSummaries(themes));
    const stored = readStoredTheme();
    if (isImportedThemeId(stored)) switchTheme(stored);
}
