import type { Density, Scale } from "../../theme/preferences.ts";
import { resolveThemeChoice, themeFile } from "../../theme/apply.ts";
import { importedThemeById } from "../../theme/imported-registry.ts";
import { DEFAULT_THEME, isThemeChoice, isThemeName, type ThemeChoice, type ThemeName } from "../../theme/tokens.ts";

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
export function themeSwatch(choice: ThemeChoice): ThemeSwatch {
    const theme = themeFile(choice);
    const color = (token: "surface" | "text" | "accent" | "border"): string => theme.palette[theme.colors[token]] ?? "";
    return { surface: color("surface"), text: color("text"), accent: color("accent"), border: color("border") };
}

export function themeLabel(choice: ThemeChoice): string {
    if (isThemeName(choice)) return THEME_LABELS[choice];
    return importedThemeById(choice)?.name ?? THEME_LABELS[DEFAULT_THEME];
}

// The root attribute carries the active theme; a missing value, or an imported theme that is not loaded, falls back to the default.
export function themeFromAttribute(value: string | null): ThemeChoice {
    return value !== null && isThemeChoice(value) ? resolveThemeChoice(value) : DEFAULT_THEME;
}
