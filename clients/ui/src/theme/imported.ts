import { BUILTIN_COLOR_SCHEME, BUILTIN_THEMES } from "./builtin.ts";
import {
    COLOR_TOKENS,
    isThemeName,
    isThemeSlug,
    type ColorToken,
    type ThemeFile,
    type ThemeName,
} from "./tokens.ts";

const MAX_NAME_CHARS = 120;
const MAX_SOURCE_CHARS = 200;
const MAX_SHADOW_CHARS = 300;
const SAVED_COLOR = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/;

// What the page needs to draw an imported theme. The saved file adds the highlighting data.
export interface ImportedThemeSummary {
    readonly slug: string;
    readonly name: string;
    // The built-in theme this one falls back to, and the base for every value that is not a color.
    readonly type: ThemeName;
    // Where the theme came from, for the person to read.
    readonly source: string;
    readonly colors: Readonly<Record<ColorToken, string>>;
    // Only the drop shadow can differ from the built-in values.
    readonly values: { readonly shadow?: string };
}

export interface ImportedTheme extends ImportedThemeSummary {
    readonly version: 1;
    readonly tokenColors: readonly unknown[];
    readonly semanticTokenColors: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function baseColor(type: ThemeName, token: ColorToken): string {
    const base = BUILTIN_THEMES[type];
    return base.palette[base.colors[token]] ?? "";
}

// A color that is missing or unreadable takes the built-in theme's value, so a file edited by hand still draws.
export function parseImportedSummary(value: unknown): ImportedThemeSummary | undefined {
    if (!isRecord(value)) return undefined;
    const { slug, name, type, source } = value;
    if (typeof slug !== "string" || !isThemeSlug(slug)) return undefined;
    if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME_CHARS) return undefined;
    if (typeof type !== "string" || !isThemeName(type)) return undefined;
    const given = isRecord(value.colors) ? value.colors : {};
    const colors = {} as Record<ColorToken, string>;
    for (const token of COLOR_TOKENS) {
        const color = given[token];
        colors[token] = typeof color === "string" && SAVED_COLOR.test(color) ? color : baseColor(type, token);
    }
    const shadow = isRecord(value.values) ? value.values.shadow : undefined;
    const keepsShadow = typeof shadow === "string" && shadow.length > 0 && shadow.length <= MAX_SHADOW_CHARS;
    return {
        slug,
        name,
        type,
        source: typeof source === "string" ? source.slice(0, MAX_SOURCE_CHARS) : "",
        colors,
        values: keepsShadow ? { shadow } : {},
    };
}

// The themes in a list from the desktop shell; an entry that does not read is left out.
export function parseImportedSummaries(value: unknown): ImportedThemeSummary[] {
    if (!Array.isArray(value)) return [];
    const themes: ImportedThemeSummary[] = [];
    for (const entry of value) {
        const theme = parseImportedSummary(entry);
        if (theme !== undefined) themes.push(theme);
    }
    return themes;
}

export function parseImportedTheme(value: unknown): ImportedTheme | undefined {
    const summary = parseImportedSummary(value);
    if (summary === undefined || !isRecord(value) || value.version !== 1) return undefined;
    return {
        ...summary,
        version: 1,
        tokenColors: Array.isArray(value.tokenColors) ? value.tokenColors : [],
        semanticTokenColors: isRecord(value.semanticTokenColors) ? value.semanticTokenColors : {},
    };
}

export function summaryOf(theme: ImportedThemeSummary): ImportedThemeSummary {
    return { slug: theme.slug, name: theme.name, type: theme.type, source: theme.source, colors: theme.colors, values: theme.values };
}

// The same shape the built-in themes have, so applying and previewing one reads every theme alike.
export function importedThemeFile(theme: ImportedThemeSummary): ThemeFile {
    const base = BUILTIN_THEMES[theme.type];
    const palette: Record<string, string> = {};
    const colors = {} as Record<ColorToken, string>;
    for (const token of COLOR_TOKENS) {
        palette[token] = theme.colors[token];
        colors[token] = token;
    }
    return {
        name: theme.name,
        palette,
        colors,
        values: { ...base.values, shadow: theme.values.shadow ?? base.values.shadow },
    };
}

const FIRST_COLOR_FUNCTION = /rgba?\([^)]*\)/;

// The built-in drop shadow with its first layer drawn in the theme's shadow color.
export function shadowFor(type: ThemeName, color: string): string {
    const base = BUILTIN_THEMES[type].values.shadow;
    return base.replace(FIRST_COLOR_FUNCTION, color);
}

export function importedColorScheme(theme: ImportedThemeSummary): "dark" | "light" {
    return BUILTIN_COLOR_SCHEME[theme.type];
}
