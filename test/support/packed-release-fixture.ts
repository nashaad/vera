import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
    BUNDLED_RELEASE_MANIFEST,
    BUNDLED_RELEASE_TARBALL,
} from "../../clients/desktop/src/release-install.ts";
import {
    RELEASE_ANNEX_NAME,
    RELEASE_CLI_NAME,
    RELEASE_HOST_NAME,
    RELEASE_SESSION_WORKER_NAME,
    RELEASE_SUPERVISOR_NAME,
    RELEASE_WORKER_NAME,
} from "../../src/release/layout.ts";
import {
    RELEASE_ARTIFACT_NAMES,
    RELEASE_LAYOUT_VERSION,
    parseReleaseManifest,
    serializeReleaseManifest,
    type ReleaseManifest,
} from "../../src/release/manifest.ts";
import { digestPackedAnnex } from "../../src/release/verify.ts";

// A small release that passes verifyPackedRelease, packed the way scripts/pack-release.ts packs one.

export interface FixtureRelease {
    readonly buildId: string;
    readonly productVersion: string;
    readonly builtAt: string;
    // Leave this file out of the tree so the release fails verification.
    readonly omit?: string;
}

export function fixtureManifest(release: FixtureRelease, annexDigest: string): ReleaseManifest {
    return {
        layout_version: RELEASE_LAYOUT_VERSION,
        product_version: release.productVersion,
        source_revision: "abc",
        build_id: release.buildId,
        protocol_version: 1,
        platform: "darwin",
        arch: "arm64",
        asset_digest: annexDigest,
        built_at: release.builtAt,
        artifacts: [...RELEASE_ARTIFACT_NAMES],
    };
}

export function writeFixtureRelease(parent: string, release: FixtureRelease): string {
    const root = join(parent, release.buildId);
    const annex = join(root, "annex");
    mkdirSync(annex, { recursive: true });
    writeFileSync(join(annex, "index.html"), "<html></html>\n");
    writeFileSync(join(annex, "main.js"), "console.log(1);\n");
    writeFileSync(join(annex, "styles.css"), "body{}\n");
    writeFileSync(join(annex, "build-id"), `${release.buildId}\n`);
    for (const name of [
        RELEASE_CLI_NAME,
        RELEASE_HOST_NAME,
        RELEASE_WORKER_NAME,
        RELEASE_SESSION_WORKER_NAME,
        RELEASE_ANNEX_NAME,
        RELEASE_SUPERVISOR_NAME,
    ]) {
        const path = join(root, name);
        writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        chmodSync(path, 0o755);
    }
    for (const entry of ["config", "extensions", "node_modules", "clients/cli", "clients/host", "src/annex", "docs"]) {
        mkdirSync(join(root, entry), { recursive: true });
    }
    writeFileSync(join(root, "clients", "cli", "main.ts"), "export {}\n");
    writeFileSync(join(root, "clients", "host", "main.ts"), "export {}\n");
    writeFileSync(join(root, "clients", "host", "session-worker.ts"), "export {}\n");
    writeFileSync(join(root, "src", "annex", "main.ts"), "export {}\n");
    writeFileSync(join(root, "docs", "index.md"), "# Vera manual\n");
    writeFileSync(join(root, "index.ts"), "export {}\n");
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "tsconfig.json"), "{}\n");
    writeFileSync(join(root, "bunfig.toml"), "");
    writeFileSync(
        join(root, "manifest.json"),
        serializeReleaseManifest(fixtureManifest(release, digestPackedAnnex(annex))),
    );
    if (release.omit !== undefined) rmSync(join(root, release.omit), { recursive: true, force: true });
    return root;
}

// Writes the three files an app carries: the archive, its checksum and the manifest.
export function writeFixtureBundle(bundleDirectory: string, release: FixtureRelease): ReleaseManifest {
    const staging = join(bundleDirectory, ".tree");
    mkdirSync(bundleDirectory, { recursive: true });
    const root = writeFixtureRelease(staging, release);
    const tarball = join(bundleDirectory, BUNDLED_RELEASE_TARBALL);
    const tar = spawnSync("tar", ["-czf", tarball, "-C", staging, release.buildId]);
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
    const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    writeFileSync(`${tarball}.sha256`, `${digest}  ${BUNDLED_RELEASE_TARBALL}\n`);
    const manifestText = readFileSync(join(root, "manifest.json"), "utf8");
    writeFileSync(join(bundleDirectory, BUNDLED_RELEASE_MANIFEST), manifestText);
    rmSync(staging, { recursive: true, force: true });
    return parseReleaseManifest(manifestText);
}
