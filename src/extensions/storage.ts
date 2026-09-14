import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import {
    EXTENSION_DATA_DIRECTORY,
    veraMachineDirectory,
    veraProfileDirectory,
} from "../profile-paths.ts";
import type { VeraExtensionStorage } from "../sdk/extensions.ts";

export function extensionStorage(id: string): VeraExtensionStorage {
    return Object.freeze({
        get profile(): string {
            return ensure(veraProfileDirectory(), id);
        },
        get machine(): string {
            return ensure(veraMachineDirectory(), id);
        },
    });
}

/**
 * Extension data lived beside Vera's own files at the tier root until
 * 2026-09-14. A directory left there is this extension's, so it moves.
 */
function ensure(tier: string, id: string): string {
    const path = join(tier, EXTENSION_DATA_DIRECTORY, id);
    if (!existsSync(path)) {
        const legacy = join(tier, id);
        if (existsSync(legacy)) {
            mkdirSync(join(tier, EXTENSION_DATA_DIRECTORY), {
                recursive: true,
                mode: 0o700,
            });
            renameSync(legacy, path);
            return path;
        }
    }
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
}
