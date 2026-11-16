import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { readManifest } from "./manifest.ts";
import { extensionRoots } from "./roots.ts";

const MAX_FOLDERS = 500;
const MAX_THEMES = 300;
const MAX_MANIFEST_BYTES = 1024 * 1024;

export interface InstalledTheme {
    readonly label: string;
    readonly extension: string;
    // The extension's folder, and the theme's path as its manifest writes it.
    readonly folder: string;
    readonly path: string;
    readonly uiTheme?: string;
}

export interface InstalledScan {
    readonly themes: readonly InstalledTheme[];
    // Set when more themes or folders were found than are listed.
    readonly cut: boolean;
}

// An installed theme as it comes back from main, which holds it unread between the list and the import.
export function parseInstalledTheme(value: unknown): InstalledTheme | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const { label, extension, folder, path, uiTheme } = value as Record<string, unknown>;
    if (typeof label !== "string" || typeof extension !== "string" || typeof folder !== "string" || typeof path !== "string") return undefined;
    if (uiTheme !== undefined && typeof uiTheme !== "string") return undefined;
    return { label, extension, folder, path, ...(uiTheme === undefined ? {} : { uiTheme }) };
}

async function readText(path: string): Promise<string | undefined> {
    try {
        const info = await stat(path);
        if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) return undefined;
        return await readFile(path, "utf8");
    } catch {
        return undefined;
    }
}

// VS Code lists the folders of replaced versions here, and they stay on disk until it cleans them up.
async function obsoleteFolders(root: string): Promise<ReadonlySet<string>> {
    const text = await readText(join(root, ".obsolete"));
    if (text === undefined) return new Set();
    try {
        const value: unknown = JSON.parse(text);
        return typeof value === "object" && value !== null ? new Set(Object.keys(value)) : new Set();
    } catch {
        return new Set();
    }
}

export async function scanInstalledThemes(roots: readonly string[] = extensionRoots()): Promise<InstalledScan> {
    const themes: InstalledTheme[] = [];
    let cut = false;
    let folders = 0;
    for (const root of roots) {
        let names: string[];
        try {
            names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
        } catch {
            continue;
        }
        const obsolete = await obsoleteFolders(root);
        for (const name of names.sort()) {
            if (obsolete.has(name)) continue;
            if (folders >= MAX_FOLDERS) {
                cut = true;
                break;
            }
            folders += 1;
            const folder = join(root, name);
            const manifestText = await readText(join(folder, "package.json"));
            if (manifestText === undefined || !manifestText.includes("\"themes\"")) continue;
            try {
                const manifest = readManifest(manifestText, await readText(join(folder, "package.nls.json")));
                for (const theme of manifest.themes) {
                    if (themes.length >= MAX_THEMES) {
                        cut = true;
                        break;
                    }
                    themes.push({
                        label: theme.label,
                        extension: manifest.extension,
                        folder,
                        path: theme.path,
                        ...(theme.uiTheme === undefined ? {} : { uiTheme: theme.uiTheme }),
                    });
                }
            } catch {
                // An extension whose manifest does not read is left out of the list.
            }
        }
    }
    themes.sort((a, b) => a.extension.localeCompare(b.extension) || a.label.localeCompare(b.label));
    return { themes, cut };
}
