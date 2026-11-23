import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { pluginsDirectoryIn } from "../profile-paths.ts";

export function canonicalExtensionPath(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}

export function withinExtensionDirectory(directory: string, path: string): boolean {
    const offset = relative(directory, path);
    return offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`));
}

export function withoutPluginExtensionPaths<T extends { readonly path: string }>(
    entries: readonly T[],
    veraHome: string | null,
): readonly T[] {
    if (veraHome === null) return entries;
    const root = resolve(pluginsDirectoryIn(veraHome));
    const realRoot = canonicalExtensionPath(root);
    return entries.filter((entry) => {
        const path = resolve(entry.path);
        const realPath = canonicalExtensionPath(entry.path);
        return !withinExtensionDirectory(root, path)
            && !withinExtensionDirectory(realRoot, path)
            && !withinExtensionDirectory(root, realPath)
            && !withinExtensionDirectory(realRoot, realPath);
    });
}
