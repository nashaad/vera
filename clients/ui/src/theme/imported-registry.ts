import { importedColorScheme, importedThemeFile, type ImportedThemeSummary } from "./imported.ts";
import { importedThemeSlug, type ThemeFile } from "./tokens.ts";

// The imported themes this window knows. The desktop shell fills it from the home; the page head fills
// it with the last applied theme so the first paint is right.
let themes: readonly ImportedThemeSummary[] = [];
const files = new Map<string, ThemeFile>();
const listeners = new Set<() => void>();

export function setImportedThemes(next: readonly ImportedThemeSummary[]): void {
    themes = next;
    files.clear();
    for (const listener of listeners) listener();
}

export function importedThemes(): readonly ImportedThemeSummary[] {
    return themes;
}

export function importedThemeById(id: string): ImportedThemeSummary | undefined {
    const slug = importedThemeSlug(id);
    return slug === undefined ? undefined : themes.find((theme) => theme.slug === slug);
}

export function importedFileById(id: string): ThemeFile | undefined {
    const theme = importedThemeById(id);
    if (theme === undefined) return undefined;
    const known = files.get(theme.slug);
    if (known !== undefined) return known;
    const file = importedThemeFile(theme);
    files.set(theme.slug, file);
    return file;
}

export function importedSchemeById(id: string): "dark" | "light" | undefined {
    const theme = importedThemeById(id);
    return theme === undefined ? undefined : importedColorScheme(theme);
}

export function subscribeImportedThemes(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
