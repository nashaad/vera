import type { Density, Scale } from "../../theme/preferences.ts";
import { themeFile } from "../../theme/apply.ts";
import { DEFAULT_THEME, isThemeName, type ThemeName } from "../../theme/tokens.ts";

export const THEME_LABELS: Readonly<Record<ThemeName, string>> = {
    dark: "Dark",
    light: "Light",
    "high-contrast": "High contrast",
};

export const SCALE_LABELS: Readonly<Record<Scale, string>> = { small: "Small", default: "Default", large: "Large" };

export const DENSITY_LABELS: Readonly<Record<Density, string>> = {
    compact: "Compact",
    default: "Default",
    comfortable: "Comfortable",
};

export interface ThemeSwatch {
    readonly surface: string;
    readonly text: string;
    readonly accent: string;
    readonly border: string;
}

// Colors come from the theme file itself, so each card shows the theme it switches to.
export function themeSwatch(name: ThemeName): ThemeSwatch {
    const theme = themeFile(name);
    const color = (token: "surface" | "text" | "accent" | "border"): string => theme.palette[theme.colors[token]] ?? "";
    return { surface: color("surface"), text: color("text"), accent: color("accent"), border: color("border") };
}

// The root attribute carries the active theme name; a missing or unknown value falls back to the default.
export function themeFromAttribute(value: string | null): ThemeName {
    return value !== null && isThemeName(value) ? value : DEFAULT_THEME;
}
