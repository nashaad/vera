import { DEFAULT_THEME, isThemeName, type ThemeName } from "./tokens.ts";

const STORAGE_KEY = "vera.theme";

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): ThemeStorage | undefined {
    try {
        return window.localStorage;
    } catch {
        return undefined;
    }
}

export function readStoredTheme(
    storage: ThemeStorage | undefined = defaultStorage(),
): ThemeName {
    try {
        const value = storage?.getItem(STORAGE_KEY);
        return value !== undefined && value !== null && isThemeName(value)
            ? value
            : DEFAULT_THEME;
    } catch {
        return DEFAULT_THEME;
    }
}

export function storeTheme(
    name: ThemeName,
    storage: ThemeStorage | undefined = defaultStorage(),
): void {
    try {
        storage?.setItem(STORAGE_KEY, name);
    } catch {
        // Storage can be unavailable in a sandboxed renderer; the theme still applies.
    }
}
