import { parseImportedSummary, summaryOf, type ImportedThemeSummary } from "./imported.ts";
import { importedThemeById } from "./imported-registry.ts";
import { DEFAULT_THEME, isThemeChoice, type ThemeChoice } from "./tokens.ts";

const STORAGE_KEY = "vera.theme";
// The colors of the last imported theme that was applied. The page head reads them before the desktop shell can,
// so an imported theme does not flash the default on launch.
const CACHE_KEY = "vera.theme.imported";

type ThemeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): ThemeStorage | undefined {
    try {
        return window.localStorage;
    } catch {
        return undefined;
    }
}

export function readStoredTheme(
    storage: ThemeStorage | undefined = defaultStorage(),
): ThemeChoice {
    try {
        const value = storage?.getItem(STORAGE_KEY);
        return value !== undefined && value !== null && isThemeChoice(value)
            ? value
            : DEFAULT_THEME;
    } catch {
        return DEFAULT_THEME;
    }
}

export function storeTheme(
    choice: ThemeChoice,
    storage: ThemeStorage | undefined = defaultStorage(),
): void {
    try {
        storage?.setItem(STORAGE_KEY, choice);
        const theme = importedThemeById(choice);
        if (theme === undefined) storage?.removeItem(CACHE_KEY);
        else storage?.setItem(CACHE_KEY, JSON.stringify(summaryOf(theme)));
    } catch {
        // Storage can be unavailable in a sandboxed renderer; the theme still applies.
    }
}

export function readThemeCache(
    storage: ThemeStorage | undefined = defaultStorage(),
): ImportedThemeSummary | undefined {
    try {
        const text = storage?.getItem(CACHE_KEY);
        return text === undefined || text === null ? undefined : parseImportedSummary(JSON.parse(text));
    } catch {
        return undefined;
    }
}
