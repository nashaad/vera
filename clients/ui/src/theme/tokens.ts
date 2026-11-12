export const COLOR_TOKENS = [
    "surface",
    "surface-sidebar",
    "surface-panel",
    "surface-raised",
    "surface-menu",
    "surface-input",
    "surface-hover",
    "surface-selected",
    "surface-code",
    "titlebar",
    "tab-active",
    "tab-inactive",
    "border",
    "border-input",
    "focus",
    "text",
    "text-muted",
    "text-dim",
    "text-disabled",
    "link",
    "accent",
    "accent-text",
    "badge",
    "badge-text",
    "danger",
    "warning",
    "success",
    "diff-added",
    "diff-removed",
    "selection",
    "scrollbar",
] as const;

export const VALUE_TOKENS = [
    "shadow",
    "font-ui",
    "font-code",
    "font-size",
    "font-size-code",
    "font-size-label",
    "font-size-body",
    "font-size-chat",
    "radius",
    "radius-sm",
    "radius-lg",
    "radius-xl",
    "space",
    "row-height",
    "motion",
] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];
export type ValueToken = (typeof VALUE_TOKENS)[number];
export type TokenName = ColorToken | ValueToken;

export const ALL_TOKENS: readonly TokenName[] = [...COLOR_TOKENS, ...VALUE_TOKENS];

export const THEME_NAMES = ["dark", "light", "high-contrast"] as const;
export type ThemeName = (typeof THEME_NAMES)[number];
export const DEFAULT_THEME: ThemeName = "dark";

export interface ThemeFile {
    readonly name: string;
    readonly palette: Record<string, string>;
    readonly colors: Record<ColorToken, string>;
    readonly values: Record<ValueToken, string>;
}

export function isThemeName(value: string): value is ThemeName {
    return (THEME_NAMES as readonly string[]).includes(value);
}
