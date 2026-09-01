import { join } from "node:path";

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
