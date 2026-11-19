import dark from "./themes/dark.json";
import light from "./themes/light.json";
import highContrast from "./themes/high-contrast.json";
import type { ThemeFile } from "./tokens.ts";

export const BASE_THEMES = { dark, light, "high-contrast": highContrast } satisfies Record<string, ThemeFile>;
export type BaseThemeName = keyof typeof BASE_THEMES;

export function isBaseThemeName(value: string): value is BaseThemeName {
    return Object.hasOwn(BASE_THEMES, value);
}
