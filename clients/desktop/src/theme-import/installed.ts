import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { InstalledScan, InstalledTheme } from "./task-protocol.ts";
import { readManifest } from "./manifest.ts";
import { extensionRoots } from "./roots.ts";

const MAX_FOLDERS = 500;
const MAX_THEMES = 300;
const MAX_MANIFEST_BYTES = 1024 * 1024;

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
                    themes.push({ label: theme.label, extension: manifest.extension, folder, path: theme.path, uiTheme: theme.uiTheme });
                }
            } catch {
                // An extension whose manifest does not read is left out of the list.
            }
        }
    }
    themes.sort((a, b) => a.extension.localeCompare(b.extension) || a.label.localeCompare(b.label));
    return { themes, cut };
}
