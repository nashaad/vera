import { runtimePath } from "./runtime-path.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { releaseBuildId } from "./build-id.ts";
import { thisProcessBuildId } from "./stamp.ts";

const CODE_ROOT = runtimePath(fileURLToPath(new URL("../..", import.meta.url)), ".");
const UNSTAMPED_BUILD_ID = "unstamped";

let resolved: string | undefined;

/**
 * The build that writes a cache file and the build that accepts it. A
 * checkout names its own source tree, because the install's stamp belongs to
 * a different build.
 */
export function cacheBuildId(): string {
    resolved ??= resolveCacheBuildId();
    return resolved;
}

function resolveCacheBuildId(): string {
    if (existsSync(join(CODE_ROOT, ".git"))) {
        try {
            return releaseBuildId(CODE_ROOT);
        } catch {
            return UNSTAMPED_BUILD_ID;
        }
    }
    try {
        return thisProcessBuildId();
    } catch {
        return UNSTAMPED_BUILD_ID;
    }
}
