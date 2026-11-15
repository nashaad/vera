import { parseImportedTheme, type ImportedTheme } from "../../../ui/src/theme/imported.ts";

// The main process imports only this file from this folder; the rest is import code for the task process.

export const THEME_TASK_SERVICE = "Vera Theme Import";
// The worker bundle, inside the included extension that contributes the task.
export const THEME_TASK_FILE = "theme-import.cjs";
// The id of the task in the importer's manifest. The extension's own id is THEME_IMPORTER_ID.
export const THEME_IMPORT_TASK = "import";

// One reply holds at most this many themes, and this many bytes of them once written as JSON.
export const MAX_REPLY_THEMES = 200;
export const MAX_REPLY_BYTES = 16 * 1024 * 1024;

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

// The converted themes travel in the reply; main installs them and the task writes nothing.
export type ImportOutcome =
    | { readonly ok: true; readonly themes: readonly ImportedTheme[]; readonly skipped: readonly string[] }
    | { readonly ok: false; readonly reason: string };

export type ThemeTask =
    | { readonly kind: "import-file"; readonly path: string }
    | { readonly kind: "import-installed"; readonly theme: InstalledTheme }
    // `roots` are the folders to search; the task uses VS Code's own when they are left out.
    | { readonly kind: "list-installed"; readonly roots?: readonly string[] };

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
    if (value.ok !== true || !Array.isArray(value.themes) || skipped === undefined) return undefined;
    if (value.themes.length > MAX_REPLY_THEMES || JSON.stringify(value.themes).length > MAX_REPLY_BYTES) return undefined;
    const themes: ImportedTheme[] = [];
    for (const entry of value.themes) {
        const theme = parseImportedTheme(entry);
        if (theme === undefined) return undefined;
        themes.push(theme);
    }
    return { ok: true, themes, skipped };
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
        return isString(value.path) ? { kind: "import-file", path: value.path } : undefined;
    }
    if (value.kind === "import-installed") {
        const theme = parseInstalledTheme(value.theme);
        return theme === undefined ? undefined : { kind: "import-installed", theme };
    }
    if (value.kind === "list-installed") {
        if (value.roots === undefined) return { kind: "list-installed" };
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
