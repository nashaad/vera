import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
    EXTENSION_DATA_DIRECTORY,
    veraMachineDirectory,
    veraProfileDirectory,
} from "../profile-paths.ts";
import type { VeraExtensionStorage } from "../sdk/extensions.ts";

export interface ExtensionStorageRoots {
    readonly profile: string;
    readonly machine: string;
}

export function extensionStorage(
    id: string,
    roots?: ExtensionStorageRoots,
): VeraExtensionStorage {
    return Object.freeze({
        get profile(): string {
            return ensure(roots?.profile ?? veraProfileDirectory(), id);
        },
        get machine(): string {
            return ensure(roots?.machine ?? veraMachineDirectory(), id);
        },
    });
}

function ensure(tier: string, id: string): string {
    const path = join(tier, EXTENSION_DATA_DIRECTORY, id);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
}
