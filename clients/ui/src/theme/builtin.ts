import darkTheme from "./themes/dark.json";
import highContrastTheme from "./themes/high-contrast.json";
import lightTheme from "./themes/light.json";
import type { ThemeFile, ThemeName } from "./tokens.ts";

export const BUILTIN_THEMES: Readonly<Record<ThemeName, ThemeFile>> = {
    dark: darkTheme,
    light: lightTheme,
    "high-contrast": highContrastTheme,
};

export const BUILTIN_COLOR_SCHEME: Readonly<Record<ThemeName, "dark" | "light">> = {
    dark: "dark",
    light: "light",
    "high-contrast": "dark",
};
