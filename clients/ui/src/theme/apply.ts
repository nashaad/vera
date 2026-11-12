import darkTheme from "./themes/dark.json";
import highContrastTheme from "./themes/high-contrast.json";
import lightTheme from "./themes/light.json";
import {
    COLOR_TOKENS,
    DEFAULT_THEME,
    VALUE_TOKENS,
    type ThemeFile,
    type ThemeName,
} from "./tokens.ts";

const THEMES: Record<ThemeName, ThemeFile> = {
    dark: darkTheme,
    light: lightTheme,
    "high-contrast": highContrastTheme,
};

export interface ThemeRoot {
    setAttribute(name: string, value: string): void;
    readonly style: { setProperty(name: string, value: string): void };
}

const COLOR_SCHEME: Record<ThemeName, "dark" | "light"> = {
    dark: "dark",
    light: "light",
    "high-contrast": "dark",
};

export function themeFile(name: ThemeName): ThemeFile {
    return THEMES[name];
}

export function applyTheme(
    name: ThemeName,
    root: ThemeRoot = document.documentElement,
): void {
    const theme = THEMES[name];
    for (const token of COLOR_TOKENS) {
        const value = theme.palette[theme.colors[token]];
        if (value !== undefined) root.style.setProperty(`--vera-${token}`, value);
    }
    for (const token of VALUE_TOKENS) {
        root.style.setProperty(`--vera-${token}`, theme.values[token]);
    }
    root.setAttribute("data-theme", name);
    root.style.setProperty("color-scheme", COLOR_SCHEME[name]);
}

export function startingThemeName(): ThemeName {
    return DEFAULT_THEME;
}
