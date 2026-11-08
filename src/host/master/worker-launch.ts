import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
    childReleaseRoot,
    RELEASE_SESSION_WORKER_NAME,
    releaseBinaryPath,
} from "../../release/layout.ts";

export function sessionWorkerSpawnSpec(
    releaseRoot: string | undefined = childReleaseRoot(),
): { readonly command: string; readonly args: readonly string[] } {
    if (releaseRoot !== undefined) {
        const packed = releaseBinaryPath(RELEASE_SESSION_WORKER_NAME, releaseRoot);
        if (existsSync(packed)) return { command: packed, args: [] };
    }
    return { command: process.execPath, args: [fileURLToPath(new URL("../../../clients/host/session-worker.ts", import.meta.url))] };
}
