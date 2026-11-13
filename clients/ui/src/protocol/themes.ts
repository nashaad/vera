import type { ImportedThemeSummary } from "../theme/imported.ts";

// `imported` is empty when the person closed the picker without choosing. `themes` is every imported theme
// after this import, `skipped` the themes of an extension package that could not be imported, with the reason.
export interface ThemeImportDone {
    readonly ok: true;
    readonly imported: readonly ImportedThemeSummary[];
    readonly themes: readonly ImportedThemeSummary[];
    readonly skipped: readonly string[];
}

export interface ThemeImportRefusal {
    readonly ok: false;
    // Phrased for the person; the current theme stays.
    readonly reason: string;
}

export type ThemeImportResult = ThemeImportDone | ThemeImportRefusal;

// One color theme of an extension installed in VS Code. `key` names it in `importInstalledTheme` until the next listing.
export interface InstalledThemeEntry {
    readonly key: string;
    readonly label: string;
    readonly extension: string;
}

export interface InstalledThemesAnswer {
    readonly ok: true;
    readonly themes: readonly InstalledThemeEntry[];
    // True when more themes were found than are listed.
    readonly cut: boolean;
}

export type InstalledThemesResult = InstalledThemesAnswer | ThemeImportRefusal;
