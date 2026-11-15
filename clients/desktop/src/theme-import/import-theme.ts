import { basename, extname, join } from "node:path";

import type { ImportedTheme } from "../../../ui/src/theme/imported.ts";
import { loadTheme } from "./chain.ts";
import { convertTheme } from "./convert.ts";
import { MAX_REPLY_BYTES, type ImportOutcome, type InstalledTheme } from "./task-protocol.ts";
import { readManifest, type ManifestTheme } from "./manifest.ts";
import { ThemeRefusal } from "./refusal.ts";
import { diskSource, fileByteSource, zipSource, type ThemeSource } from "./source.ts";
import { MAX_THEME_BYTES } from "../theme-store.ts";

const GENERIC_REFUSAL = "Vera could not read that file as a theme.";

// Counts the bytes of the themes one reply carries, which are kept under MAX_REPLY_BYTES.
export class ReplyBudget {
    private used = 0;

    // The theme as it will be sent. Refuses one that is too large, or that the reply no longer has room for.
    take(theme: ImportedTheme): ImportedTheme {
        const size = JSON.stringify(theme).length;
        if (size > MAX_THEME_BYTES) {
            throw new ThemeRefusal(`"${theme.name}" is larger than ${MAX_THEME_BYTES / 1024 / 1024} MiB once saved.`);
        }
        if (this.used + size > MAX_REPLY_BYTES) {
            throw new ThemeRefusal(`This import already holds ${MAX_REPLY_BYTES / 1024 / 1024} MiB of themes.`);
        }
        this.used += size;
        return theme;
    }
}

// Imports each theme of an extension, and reports the ones it skipped. Refuses only when none could be imported.
function importManifestThemes(
    source: ThemeSource,
    manifestFile: string,
    themes: readonly ManifestTheme[],
    sourceName: string,
): ImportOutcome {
    if (themes.length === 0) return { ok: false, reason: "The extension does not contribute any color themes." };
    const budget = new ReplyBudget();
    const imported: ImportedTheme[] = [];
    const skipped: string[] = [];
    let firstReason = GENERIC_REFUSAL;
    for (const entry of themes) {
        try {
            const path = source.resolve(manifestFile, entry.path);
            const loaded = loadTheme(source, path);
            const theme = convertTheme(loaded, { name: entry.label, source: sourceName, ...(entry.uiTheme === undefined ? {} : { uiTheme: entry.uiTheme }) });
            imported.push(budget.take(theme));
        } catch (error) {
            const reason = reasonOf(error);
            if (skipped.length === 0) firstReason = reason;
            skipped.push(`${entry.label}: ${reason}`);
        }
    }
    return imported.length === 0 ? { ok: false, reason: firstReason } : { ok: true, themes: imported, skipped };
}

function reasonOf(error: unknown): string {
    return error instanceof ThemeRefusal ? error.message : GENERIC_REFUSAL;
}

function importJsonFile(path: string): ImportedTheme {
    const loaded = loadTheme(diskSource, path);
    const name = loaded.name ?? basename(path, extname(path));
    return new ReplyBudget().take(convertTheme(loaded, { name, source: `File ${basename(path)}` }));
}

function importVsix(path: string): ImportOutcome {
    const file = fileByteSource(path);
    try {
        const source = zipSource(file.source);
        const manifestFile = "extension/package.json";
        if (!source.has(manifestFile)) throw new ThemeRefusal("The .vsix has no extension/package.json, so it is not an extension package.");
        const nlsFile = "extension/package.nls.json";
        const manifest = readManifest(source.read(manifestFile), source.has(nlsFile) ? source.read(nlsFile) : undefined);
        return importManifestThemes(source, manifestFile, manifest.themes, `Extension ${manifest.extension}`);
    } finally {
        file.close();
    }
}

// A theme file or an extension package the person chose. It refuses unless at least one theme converts.
export function importThemeFile(path: string): ImportOutcome {
    try {
        const extension = extname(path).toLowerCase();
        if (extension === ".vsix") return importVsix(path);
        if (extension === ".json" || extension === ".jsonc") {
            return { ok: true, themes: [importJsonFile(path)], skipped: [] };
        }
        return { ok: false, reason: "Choose a .json theme file or a .vsix extension package." };
    } catch (error) {
        return { ok: false, reason: reasonOf(error) };
    }
}

// A theme of an extension installed in VS Code on this machine.
export function importInstalledTheme(theme: InstalledTheme): ImportOutcome {
    try {
        const manifestFile = join(theme.folder, "package.json");
        const entry: ManifestTheme = { label: theme.label, uiTheme: theme.uiTheme, path: theme.path };
        return importManifestThemes(diskSource, manifestFile, [entry], `Extension ${theme.extension}`);
    } catch (error) {
        return { ok: false, reason: reasonOf(error) };
    }
}
