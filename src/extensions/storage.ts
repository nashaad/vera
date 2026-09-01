import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { veraMachineDirectory, veraProfileDirectory } from "../profile-paths.ts";
import type { VeraExtensionStorage } from "../sdk/extensions.ts";

export function extensionStorage(id: string): VeraExtensionStorage {
    return Object.freeze({
        get profile(): string {
            return ensure(join(veraProfileDirectory(), id));
        },
        get machine(): string {
            return ensure(join(veraMachineDirectory(), id));
        },
    });
}

function ensure(path: string): string {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
}
