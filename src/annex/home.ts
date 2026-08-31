import { join } from "node:path";

import { veraProfileName } from "../profile-paths.ts";

/**
 * Paths the annex reads from a Vera home. `--home` is VERA_HOME: the `.vera`
 * directory, not the OS home. The annex does not follow VERA_RUNTIME_DIR; the
 * home argument is the selector.
 */
export function annexPathsFromHome(veraHome: string): {
    readonly sessionDirectory: string;
    readonly catalogCacheDir: string;
    readonly reviewLogPath: string;
} {
    const runtime = join(
        veraHome,
        "profiles",
        veraProfileName(),
        "runtime",
    );
    return {
        sessionDirectory: join(runtime, "sessions"),
        catalogCacheDir: join(runtime, "cache"),
        reviewLogPath: join(runtime, "logs", "reviewer.jsonl"),
    };
}
