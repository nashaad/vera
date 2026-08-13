import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { veraMachineDirectory, veraProfileDirectory } from "../profile-paths.ts";
import type { VeraExtensionStorage } from "../sdk/extensions.ts";

/**
 * An extension gets its own directory rather than a tier root, so it cannot
 * write beside `config.json` or into another extension's state. The manifest id
 * names it, and the id pattern already excludes separators.
 */
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
