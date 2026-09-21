import { chmodSync, cpSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import {
    packedAnnexRoot,
    RELEASE_BUN_NAME,
    releaseManifestPath,
} from "./layout.ts";
import { writeSelfContainedWrappers } from "./wrappers.ts";

const RUNTIME_ENTRIES = [
    "clients",
    "config",
    "docs",
    "extensions",
    "src",
    "index.ts",
    "package.json",
    "tsconfig.json",
    "bunfig.toml",
] as const;

export function assembleRunnableRelease(
    releaseRoot: string,
    sourceRoot: string,
    bunPath: string = process.execPath,
): void {
    if (!existsSync(releaseManifestPath(releaseRoot))) {
        throw new Error(
            `No release stamp at ${releaseManifestPath(releaseRoot)}. `
                + "Pack this tree first with bun run pack:release.",
        );
    }
    if (!existsSync(packedAnnexRoot(releaseRoot))) {
        throw new Error(
            `Packed annex assets missing at ${packedAnnexRoot(releaseRoot)}`,
        );
    }
    for (const entry of RUNTIME_ENTRIES) {
        const from = join(sourceRoot, entry);
        if (!existsSync(from)) {
            throw new Error(`Release source is missing ${entry} at ${from}`);
        }
        copyInto(from, join(releaseRoot, entry));
    }
    // docs/site is the website build project, not reading material.
    rmSync(join(releaseRoot, "docs", "site"), { recursive: true, force: true });
    const modules = join(sourceRoot, "node_modules");
    if (!existsSync(modules)) {
        throw new Error(
            `Release source has no node_modules at ${modules}. Run bun install.`,
        );
    }
    copyInto(modules, join(releaseRoot, "node_modules"));
    const bunSource = realpathSync(bunPath);
    const bunDest = join(releaseRoot, RELEASE_BUN_NAME);
    cpSync(bunSource, bunDest);
    chmodSync(bunDest, 0o755);
    writeSelfContainedWrappers(releaseRoot);
}

function copyInto(from: string, to: string): void {
    mkdirSync(dirname(to), { recursive: true });
    if (process.platform === "darwin") {
        const cloned = Bun.spawnSync(["cp", "-Rc", from, to], {
            stdout: "pipe",
            stderr: "pipe",
        });
        if (cloned.exitCode === 0) return;
    }
    const copied = Bun.spawnSync(["cp", "-a", from, to], {
        stdout: "pipe",
        stderr: "pipe",
    });
    if (copied.exitCode === 0) return;
    cpSync(from, to, { recursive: true });
}
