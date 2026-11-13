import { BUILTIN_COLOR_SCHEME, BUILTIN_THEMES } from "./builtin.ts";
import { importedFileById, importedSchemeById } from "./imported-registry.ts";
import {
    COLOR_TOKENS,
    DEFAULT_THEME,
    isThemeName,
    VALUE_TOKENS,
    type ThemeChoice,
    type ThemeFile,
    type ThemeName,
} from "./tokens.ts";

export interface ThemeRoot {
    setAttribute(name: string, value: string): void;
    readonly style: { setProperty(name: string, value: string): void };
}

// An imported theme that is not loaded, such as one whose file was removed, resolves to the default.
export function resolveThemeChoice(choice: ThemeChoice): ThemeChoice {
    return isThemeName(choice) || importedFileById(choice) !== undefined ? choice : DEFAULT_THEME;
}

export function themeFile(choice: ThemeChoice): ThemeFile {
    if (isThemeName(choice)) return BUILTIN_THEMES[choice];
    return importedFileById(choice) ?? BUILTIN_THEMES[DEFAULT_THEME];
}

function colorScheme(choice: ThemeChoice): "dark" | "light" {
    if (isThemeName(choice)) return BUILTIN_COLOR_SCHEME[choice];
    return importedSchemeById(choice) ?? BUILTIN_COLOR_SCHEME[DEFAULT_THEME];
}

// Returns the choice that was applied, which is the default when the one asked for is not loaded.
export function applyTheme(
    choice: ThemeChoice,
    root: ThemeRoot = document.documentElement,
): ThemeChoice {
    const applied = resolveThemeChoice(choice);
    const theme = themeFile(applied);
    for (const token of COLOR_TOKENS) {
        const value = theme.palette[theme.colors[token]];
        if (value !== undefined) root.style.setProperty(`--vera-${token}`, value);
    }
    for (const token of VALUE_TOKENS) {
        root.style.setProperty(`--vera-${token}`, theme.values[token]);
    }
    root.setAttribute("data-theme", applied);
    root.style.setProperty("color-scheme", colorScheme(applied));
    return applied;
}

export function startingThemeName(): ThemeName {
    return DEFAULT_THEME;
}
