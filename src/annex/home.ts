import { join } from "node:path";

/**
 * Paths the annex reads from a Vera home. `--home` is VERA_HOME: the `.vera`
 * directory, not the OS home.
 */
export function annexPathsFromHome(veraHome: string): {
    readonly sessionDirectory: string;
    readonly catalogCacheDir: string;
    readonly reviewLogPath: string;
} {
    const runtime = join(veraHome, "runtime");
    return {
        sessionDirectory: join(runtime, "sessions"),
        catalogCacheDir: join(runtime, "cache"),
        reviewLogPath: join(runtime, "logs", "reviewer.jsonl"),
    };
}
