import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { MAX_FOLDER_CHECKS } from "../../ui/src/protocol/bridge.ts";

const MAX_PATH_CHARS = 4096;

// A list that is not an array or is over the cap is refused as empty; entries that are not
// absolute paths are never reported as folders.
export function folderListArgument(value: unknown): readonly string[] {
    if (!Array.isArray(value) || value.length > MAX_FOLDER_CHECKS) return [];
    return value.filter((entry): entry is string =>
        typeof entry === "string" && entry.length <= MAX_PATH_CHARS && isAbsolute(entry));
}

// The paths that exist as directories, in the order given.
export async function existingFolders(folders: readonly string[]): Promise<readonly string[]> {
    const found = await Promise.all(folders.map(async (folder) => {
        try {
            return (await stat(folder)).isDirectory();
        } catch {
            return false;
        }
    }));
    return folders.filter((_, index) => found[index]);
}
