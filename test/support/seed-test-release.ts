import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
    packedReleaseRoot,
    releaseManifestPath,
} from "../../src/release/layout.ts";

/**
 * Copy the test process's stamped current release into an isolated HOME so a
 * spawned child that is not under test preload can still read the stamp and
 * spawn host wrappers.
 */
export function seedTestRelease(home: string): void {
    const source = packedReleaseRoot();
    const current = join(home, ".local", "share", "vera", "current");
    mkdirSync(current, { recursive: true, mode: 0o700 });
    copyFileSync(releaseManifestPath(source), join(current, "manifest.json"));
    for (const name of readdirSync(source)) {
        if (name === "manifest.json") continue;
        const from = join(source, name);
        if (!existsSync(from) || !statSync(from).isFile()) continue;
        const to = join(current, name);
        copyFileSync(from, to);
        chmodSync(to, statSync(from).mode & 0o777);
    }
}
