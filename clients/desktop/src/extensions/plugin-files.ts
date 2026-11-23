import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { MAX_PACKAGE_ENTRIES, MAX_PACKAGE_FILE_BYTES, MAX_PACKAGE_PATH_CHARS, MAX_PACKAGE_TOTAL_BYTES } from "./limits.ts";

export function desktopPluginFilesProblem(root: string): string | undefined {
    let entries = 0;
    let bytes = 0;
    const pending = [""];
    const names = new Set<string>();
    try {
        while (pending.length > 0) {
            const parent = pending.pop()!;
            const directory = opendirSync(join(root, parent));
            try {
                let item;
                while ((item = directory.readSync()) !== null) {
                    entries += 1;
                    if (entries > MAX_PACKAGE_ENTRIES) return `The desktop extension has more than ${MAX_PACKAGE_ENTRIES} entries.`;
                    const path = join(parent, item.name);
                    if (path.length > MAX_PACKAGE_PATH_CHARS) return `A desktop extension path is longer than ${MAX_PACKAGE_PATH_CHARS} characters.`;
                    const folded = path.toLowerCase();
                    if (names.has(folded)) return "The desktop extension has paths that differ only by case.";
                    names.add(folded);
                    const fullPath = join(root, path);
                    const details = lstatSync(fullPath);
                    if (details.isSymbolicLink()) return "The desktop extension contains a symbolic link.";
                    const offset = relative(root, realpathSync(fullPath));
                    if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) return "A desktop extension path leaves the plugin.";
                    if (details.isDirectory()) {
                        pending.push(path);
                    } else if (details.isFile()) {
                        if (details.size > MAX_PACKAGE_FILE_BYTES) return `A desktop extension file is larger than ${MAX_PACKAGE_FILE_BYTES / 1024 / 1024} MiB.`;
                        bytes += details.size;
                        if (bytes > MAX_PACKAGE_TOTAL_BYTES) return `The desktop extension is larger than ${MAX_PACKAGE_TOTAL_BYTES / 1024 / 1024} MiB.`;
                    } else {
                        return "The desktop extension contains a special file.";
                    }
                }
            } finally {
                directory.closeSync();
            }
        }
    } catch {
        return "The desktop extension folder could not be read.";
    }
    return undefined;
}
