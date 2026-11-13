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
    "menu-check",
    "slider-value",
    "slider-rail",
    "slider-fill",
    "slider-stop",
    "slider-knob",
] as const;

export const VALUE_TOKENS = [
    "shadow",
    "shadow-knob",
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
    "motion-slow",
    "motion-loop",
] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];
export type ValueToken = (typeof VALUE_TOKENS)[number];
export type TokenName = ColorToken | ValueToken;

export const ALL_TOKENS: readonly TokenName[] = [...COLOR_TOKENS, ...VALUE_TOKENS];

export const THEME_NAMES = ["dark", "light", "high-contrast"] as const;
export type ThemeName = (typeof THEME_NAMES)[number];
export const DEFAULT_THEME: ThemeName = "dark";

export const IMPORTED_THEME_PREFIX = "imported:";
export type ImportedThemeId = `imported:${string}`;
// A theme the person can choose: one of the built-in names or an imported theme's id.
export type ThemeChoice = ThemeName | ImportedThemeId;

const THEME_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ThemeFile {
    readonly name: string;
    readonly palette: Record<string, string>;
    readonly colors: Record<ColorToken, string>;
    readonly values: Record<ValueToken, string>;
}

export function isThemeName(value: string): value is ThemeName {
    return (THEME_NAMES as readonly string[]).includes(value);
}

export function isThemeSlug(value: string): boolean {
    return THEME_SLUG.test(value);
}

export function importedThemeId(slug: string): ImportedThemeId {
    return `${IMPORTED_THEME_PREFIX}${slug}`;
}

// The slug of a well-formed imported id, which is also the theme file's name without `.json`.
export function importedThemeSlug(value: string): string | undefined {
    if (!value.startsWith(IMPORTED_THEME_PREFIX)) return undefined;
    const slug = value.slice(IMPORTED_THEME_PREFIX.length);
    return isThemeSlug(slug) ? slug : undefined;
}

export function isImportedThemeId(value: string): value is ImportedThemeId {
    return importedThemeSlug(value) !== undefined;
}

export function isThemeChoice(value: string): value is ThemeChoice {
    return isThemeName(value) || isImportedThemeId(value);
}
