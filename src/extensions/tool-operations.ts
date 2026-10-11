import { realpathSync } from "node:fs";
import { relative, isAbsolute } from "node:path";

import { CORE_PERMISSION_OPERATIONS } from "../engine/permissions.ts";
import { CORE_EXTENSIONS_DIRECTORY, SHIPPED_EXTENSIONS_DIRECTORY } from "./included.ts";
import type { LoadedExtensionManifest } from "./manifest.ts";

export const UNREVIEWED_OPERATIONS: ReadonlySet<string> = new Set([
    "extension.storage.read",
    "extension.storage.write",
]);

// Throws when an extension tool claims an operation it may not.
export function checkToolOperation(
    loaded: LoadedExtensionManifest,
    toolName: string,
    operation: string | undefined,
): void {
    if (operation === undefined) return;
    if (UNREVIEWED_OPERATIONS.has(operation)) {
        if (!loaded.manifest.unreviewedTools.includes(toolName)) {
            throw new Error(
                `Extension tool ${toolName} declares ${operation} but is not listed in unreviewed_tools`,
            );
        }
        return;
    }
    if (CORE_PERMISSION_OPERATIONS.has(operation) && !isShippedDirectory(loaded.directory)) {
        throw new Error(`Extension tool ${toolName} declares reserved operation ${operation}`);
    }
}

// loaded.directory is already a real path; the shipped roots may sit behind a symlink.
export function isShippedDirectory(directory: string): boolean {
    return [CORE_EXTENSIONS_DIRECTORY, SHIPPED_EXTENSIONS_DIRECTORY].some((root) => {
        const real = realPath(root);
        if (real === undefined) return false;
        const path = relative(real, directory);
        return path.length > 0 && !path.startsWith("..") && !isAbsolute(path);
    });
}

function realPath(path: string): string | undefined {
    try {
        return realpathSync(path);
    } catch {
        return undefined;
    }
}
