import "./pin-home.ts";

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { TEST_USER_HOME } from "./pin-home.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// .env.test points VERA_HOME at a throwaway tree so no test reads or writes the
// real one. Bun does not override a parent-shell HOME from .env.test, so
// pin-home.ts sets HOME before layout code runs. Spawned children still need
// HOME in the env object they are given.
if ((process.env[VERA_HOME_ENV] ?? "").trim().length === 0) {
    throw new Error("tests need VERA_HOME set, normally from .env.test");
}

const home = veraHomeDirectory();
if (home.endsWith(".vera-test-home")) {
    rmSync(home, { recursive: true, force: true });
}
mkdirSync(home, { recursive: true });

if (process.env.HOME !== TEST_USER_HOME) {
    throw new Error(
        `tests need HOME at ${TEST_USER_HOME}, got ${process.env.HOME ?? ""}`,
    );
}
if (!packedReleaseRoot().includes(".vera-test-user")) {
    throw new Error(
        `tests would write a release stamp at ${packedReleaseRoot()}`,
    );
}

mkdirSync(TEST_USER_HOME, { recursive: true, mode: 0o700 });

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
