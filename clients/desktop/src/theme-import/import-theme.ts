import { basename, extname, join } from "node:path";

import type { ImportedTheme, ImportedThemeSummary } from "../../../ui/src/theme/imported.ts";
import { summaryOf } from "../../../ui/src/theme/imported.ts";
import { loadTheme } from "./chain.ts";
import { convertTheme } from "./convert.ts";
import type { ImportOutcome, InstalledTheme } from "./task-protocol.ts";
import { readManifest, type ManifestTheme } from "./manifest.ts";
import { ThemeRefusal } from "./refusal.ts";
import { diskSource, fileByteSource, zipSource, type ThemeSource } from "./source.ts";
import { MAX_SAVED_THEMES, MAX_THEME_BYTES, type ThemeStore } from "../theme-store.ts";

const GENERIC_REFUSAL = "Vera could not read that file as a theme.";

// Converts and saves one theme. Refuses when it is too large or when the folder already holds the most themes.
function save(store: ThemeStore, theme: ImportedTheme): ImportedThemeSummary {
    if (JSON.stringify(theme).length > MAX_THEME_BYTES) {
        throw new ThemeRefusal(`"${theme.name}" is larger than ${MAX_THEME_BYTES / 1024 / 1024} MiB once saved.`);
    }
    if (!store.has(theme.slug) && store.slugs().length >= MAX_SAVED_THEMES) {
        throw new ThemeRefusal(`Vera keeps at most ${MAX_SAVED_THEMES} imported themes. Remove one from the themes folder first.`);
    }
    if (!store.save(theme)) throw new ThemeRefusal(`Vera could not save "${theme.name}" in its themes folder.`);
    return summaryOf(theme);
}

// Imports each theme of an extension, and reports the ones it skipped. Refuses only when none could be imported.
function importManifestThemes(
    store: ThemeStore,
    source: ThemeSource,
    manifestFile: string,
    themes: readonly ManifestTheme[],
    sourceName: string,
): ImportOutcome {
    if (themes.length === 0) return { ok: false, reason: "The extension does not contribute any color themes." };
    const imported: ImportedThemeSummary[] = [];
    const skipped: string[] = [];
    let firstReason = GENERIC_REFUSAL;
    for (const entry of themes) {
        try {
            const path = source.resolve(manifestFile, entry.path);
            const loaded = loadTheme(source, path);
            const theme = convertTheme(loaded, { name: entry.label, source: sourceName, ...(entry.uiTheme === undefined ? {} : { uiTheme: entry.uiTheme }) });
            imported.push(save(store, theme));
        } catch (error) {
            const reason = reasonOf(error);
            if (skipped.length === 0) firstReason = reason;
            skipped.push(`${entry.label}: ${reason}`);
        }
    }
    return imported.length === 0 ? { ok: false, reason: firstReason } : { ok: true, imported, skipped };
}

function reasonOf(error: unknown): string {
    return error instanceof ThemeRefusal ? error.message : GENERIC_REFUSAL;
}

function importJsonFile(store: ThemeStore, path: string): ImportedThemeSummary {
    const loaded = loadTheme(diskSource, path);
    const name = loaded.name ?? basename(path, extname(path));
    return save(store, convertTheme(loaded, { name, source: `File ${basename(path)}` }));
}

function importVsix(store: ThemeStore, path: string): ImportOutcome {
    const file = fileByteSource(path);
    try {
        const source = zipSource(file.source);
        const manifestFile = "extension/package.json";
        if (!source.has(manifestFile)) throw new ThemeRefusal("The .vsix has no extension/package.json, so it is not an extension package.");
        const nlsFile = "extension/package.nls.json";
        const manifest = readManifest(source.read(manifestFile), source.has(nlsFile) ? source.read(nlsFile) : undefined);
        return importManifestThemes(store, source, manifestFile, manifest.themes, `Extension ${manifest.extension}`);
    } finally {
        file.close();
    }
}

// A theme file or an extension package the person chose. Nothing is saved unless at least one theme imports.
export function importThemeFile(store: ThemeStore, path: string): ImportOutcome {
    try {
        const extension = extname(path).toLowerCase();
        if (extension === ".vsix") return importVsix(store, path);
        if (extension === ".json" || extension === ".jsonc") {
            return { ok: true, imported: [importJsonFile(store, path)], skipped: [] };
        }
        return { ok: false, reason: "Choose a .json theme file or a .vsix extension package." };
    } catch (error) {
        return { ok: false, reason: reasonOf(error) };
    }
}

// A theme of an extension installed in VS Code on this machine.
export function importInstalledTheme(store: ThemeStore, theme: InstalledTheme): ImportOutcome {
    try {
        const manifestFile = join(theme.folder, "package.json");
        const entry: ManifestTheme = { label: theme.label, uiTheme: theme.uiTheme, path: theme.path };
        return importManifestThemes(store, diskSource, manifestFile, [entry], `Extension ${theme.extension}`);
    } catch (error) {
        return { ok: false, reason: reasonOf(error) };
    }
}
