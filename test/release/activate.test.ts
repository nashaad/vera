import { expect, test } from "bun:test";
import {
    chmodSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readlinkSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activateRelease } from "../../src/release/activate.ts";
import {
    currentSymlinkPath,
    launcherPath,
    packedReleaseRoot,
    releaseDirectory,
} from "../../src/release/layout.ts";
import {
    RELEASE_ARTIFACT_NAMES,
    RELEASE_LAYOUT_VERSION,
    VERA_PRODUCT_VERSION,
    serializeReleaseManifest,
} from "../../src/release/manifest.ts";

function writeDummyRelease(prefix: string, buildId: string): string {
    const root = releaseDirectory(buildId, prefix);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "manifest.json"), serializeReleaseManifest({
        layout_version: RELEASE_LAYOUT_VERSION,
        product_version: VERA_PRODUCT_VERSION,
        source_revision: "abc",
        build_id: buildId,
        protocol_version: 1,
        platform: "darwin",
        arch: "arm64",
        asset_digest: `sha256:${"ab".repeat(32)}`,
        built_at: "2026-08-31T00:00:00.000Z",
        artifacts: [...RELEASE_ARTIFACT_NAMES],
    }));
    writeFileSync(join(root, "vera"), "#!/bin/sh\necho dummy\n", {
        encoding: "utf8",
        mode: 0o755,
    });
    chmodSync(join(root, "vera"), 0o755);
    return root;
}

test("activateRelease swaps current with a relative symlink", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-activate-"));
    try {
        const first = writeDummyRelease(prefix, "vera-one");
        activateRelease(first, prefix);
        expect(readlinkSync(currentSymlinkPath(prefix))).toBe("releases/vera-one");
        expect(lstatSync(currentSymlinkPath(prefix)).isSymbolicLink()).toBe(true);
        expect(packedReleaseRoot(prefix)).toBe(currentSymlinkPath(prefix));

        const second = writeDummyRelease(prefix, "vera-two");
        activateRelease(second, prefix);
        expect(readlinkSync(currentSymlinkPath(prefix))).toBe("releases/vera-two");
        expect(lstatSync(first).isDirectory()).toBe(true);

        const launched = Bun.spawnSync([launcherPath(prefix)], {
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(launched.exitCode).toBe(0);
        expect(launched.stdout.toString()).toBe("dummy\n");
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("the launcher names pack:release when current is missing", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-launcher-missing-"));
    try {
        const first = writeDummyRelease(prefix, "vera-one");
        activateRelease(first, prefix);
        rmSync(currentSymlinkPath(prefix), { force: true });
        const launched = Bun.spawnSync([launcherPath(prefix)], {
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(launched.exitCode).not.toBe(0);
        expect(launched.stderr.toString()).toMatch(/no activated release/);
        expect(launched.stderr.toString()).toMatch(/pack:release/);
        expect(launched.stdout.toString()).toBe("");
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});
