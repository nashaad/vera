import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HOST_PROTOCOL_VERSION } from "../src/host/protocol.ts";
import { VERA_HOME_ENV, veraHomeDirectory } from "../src/profile-paths.ts";
import {
    packedReleaseRoot,
    releaseManifestPath,
} from "../src/release/layout.ts";
import {
    RELEASE_ARTIFACT_NAMES,
    RELEASE_LAYOUT_VERSION,
    VERA_PRODUCT_VERSION,
    parseReleaseManifest,
    serializeReleaseManifest,
} from "../src/release/manifest.ts";
import {
    releaseSourceEntries,
    writeExternalWrappers,
} from "../src/release/wrappers.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// .env.test points VERA_HOME at a throwaway tree so no test reads or writes the
// real one, and HOME at a throwaway user so no test writes the real ~/.local.
// Spawned hosts and TUIs inherit them only because they are real environment
// entries, not process.env mutations, and a test that wants its own tree sets
// them on the child it spawns.
if ((process.env[VERA_HOME_ENV] ?? "").trim().length === 0) {
    throw new Error("tests need VERA_HOME set, normally from .env.test");
}
const home = veraHomeDirectory();
if (home.endsWith(".vera-test-home")) {
    rmSync(home, { recursive: true, force: true });
}
mkdirSync(home, { recursive: true });

const userHome = homedir();
if (userHome.endsWith(".vera-test-user")) {
    rmSync(userHome, { recursive: true, force: true });
    mkdirSync(userHome, { recursive: true, mode: 0o700 });
}

try {
    parseReleaseManifest(readFileSync(releaseManifestPath(), "utf8"));
} catch {
    const releaseRoot = packedReleaseRoot();
    mkdirSync(releaseRoot, { recursive: true });
    writeFileSync(
        releaseManifestPath(),
        serializeReleaseManifest({
            layout_version: RELEASE_LAYOUT_VERSION,
            product_version: VERA_PRODUCT_VERSION,
            source_revision: "test",
            build_id: "vera-test",
            protocol_version: HOST_PROTOCOL_VERSION,
            platform: process.platform,
            arch: process.arch,
            asset_digest: `sha256:${"00".repeat(32)}`,
            built_at: "2026-08-31T00:00:00.000Z",
            artifacts: [...RELEASE_ARTIFACT_NAMES],
        }),
    );
    writeExternalWrappers(
        releaseRoot,
        process.execPath,
        releaseSourceEntries(REPO_ROOT),
    );
}
