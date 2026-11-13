import { parseImportedSummaries, type ImportedThemeSummary } from "../../../ui/src/theme/imported.ts";

// The main process imports only this file and roots.ts from this folder; the rest is import code for the task process.

export const THEME_TASK_SERVICE = "Vera Theme Import";
export const THEME_TASK_FILE = "theme-import.cjs";

export interface InstalledTheme {
    readonly label: string;
    readonly extension: string;
    // The extension's folder, and the theme's path as its manifest writes it.
    readonly folder: string;
    readonly path: string;
    readonly uiTheme: string | undefined;
}

export interface InstalledScan {
    readonly themes: readonly InstalledTheme[];
    // Set when more themes or folders were found than are listed.
    readonly cut: boolean;
}

export type ImportOutcome =
    | { readonly ok: true; readonly imported: readonly ImportedThemeSummary[]; readonly skipped: readonly string[] }
    | { readonly ok: false; readonly reason: string };

export type ThemeTask =
    | { readonly kind: "import-file"; readonly directory: string; readonly path: string }
    | { readonly kind: "import-installed"; readonly directory: string; readonly theme: InstalledTheme }
    | { readonly kind: "list-installed"; readonly roots: readonly string[] };

export type ThemeTaskReply =
    | { readonly kind: "imported"; readonly outcome: ImportOutcome }
    | { readonly kind: "listed"; readonly scan: InstalledScan };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
    return typeof value === "string";
}

function strings(value: unknown): string[] | undefined {
    return Array.isArray(value) && value.every(isString) ? value : undefined;
}

function parseInstalledTheme(value: unknown): InstalledTheme | undefined {
    if (!isRecord(value)) return undefined;
    const { label, extension, folder, path, uiTheme } = value;
    if (!isString(label) || !isString(extension) || !isString(folder) || !isString(path)) return undefined;
    if (uiTheme !== undefined && !isString(uiTheme)) return undefined;
    return { label, extension, folder, path, uiTheme };
}

function parseOutcome(value: unknown): ImportOutcome | undefined {
    if (!isRecord(value)) return undefined;
    if (value.ok === false) return isString(value.reason) ? { ok: false, reason: value.reason } : undefined;
    const skipped = strings(value.skipped);
    if (value.ok !== true || !Array.isArray(value.imported) || skipped === undefined) return undefined;
    const imported = parseImportedSummaries(value.imported);
    return imported.length === value.imported.length ? { ok: true, imported, skipped } : undefined;
}

function parseScan(value: unknown): InstalledScan | undefined {
    if (!isRecord(value) || !Array.isArray(value.themes) || typeof value.cut !== "boolean") return undefined;
    const themes: InstalledTheme[] = [];
    for (const entry of value.themes) {
        const theme = parseInstalledTheme(entry);
        if (theme === undefined) return undefined;
        themes.push(theme);
    }
    return { themes, cut: value.cut };
}

export function parseThemeTask(value: unknown): ThemeTask | undefined {
    if (!isRecord(value)) return undefined;
    if (value.kind === "import-file") {
        return isString(value.directory) && isString(value.path) ? { kind: "import-file", directory: value.directory, path: value.path } : undefined;
    }
    if (value.kind === "import-installed") {
        const theme = parseInstalledTheme(value.theme);
        return isString(value.directory) && theme !== undefined ? { kind: "import-installed", directory: value.directory, theme } : undefined;
    }
    if (value.kind === "list-installed") {
        const roots = strings(value.roots);
        return roots === undefined ? undefined : { kind: "list-installed", roots };
    }
    return undefined;
}

export function parseThemeTaskReply(value: unknown): ThemeTaskReply | undefined {
    if (!isRecord(value)) return undefined;
    if (value.kind === "imported") {
        const outcome = parseOutcome(value.outcome);
        return outcome === undefined ? undefined : { kind: "imported", outcome };
    }
    if (value.kind === "listed") {
        const scan = parseScan(value.scan);
        return scan === undefined ? undefined : { kind: "listed", scan };
    }
    return undefined;
}
