import { opendir, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import type { Dirent } from "node:fs";

import { MAX_FOLDER_ENTRIES, type FolderEntry, type FolderListing } from "../../ui/src/protocol/bridge.ts";

const MAX_PATH_CHARS = 4096;
const SKIPPED = new Set([".git", ".DS_Store"]);

export function folderArgument(value: unknown): string | undefined {
    if (typeof value !== "string" || value.length > MAX_PATH_CHARS || !isAbsolute(value)) return undefined;
    return normalize(value);
}

// Reading stops at the cap, so a larger folder lists the entries the system returned first, not the first by name.
export async function listFolder(folder: string): Promise<FolderListing> {
    const entries: FolderEntry[] = [];
    let cut = false;
    try {
        for await (const entry of await opendir(folder)) {
            if (SKIPPED.has(entry.name)) continue;
            if (entries.length === MAX_FOLDER_ENTRIES) {
                cut = true;
                break;
            }
            entries.push({ name: entry.name, folder: await isFolder(folder, entry) });
        }
    } catch {
        return { ok: false, reason: "This folder could not be read." };
    }
    entries.sort(byFolderThenName);
    return { ok: true, entries, cut };
}

async function isFolder(parent: string, entry: Dirent): Promise<boolean> {
    if (entry.isDirectory()) return true;
    if (!entry.isSymbolicLink()) return false;
    try {
        return (await stat(join(parent, entry.name))).isDirectory();
    } catch {
        return false;
    }
}

function byFolderThenName(a: FolderEntry, b: FolderEntry): number {
    if (a.folder !== b.folder) return a.folder ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}
