import { expect, test } from "bun:test";
import {
    chmodSync,
    existsSync,
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
    currentReleaseBuildId,
    currentSymlinkPath,
    releaseDirectory,
    upgradeJournalPath,
} from "../../src/release/layout.ts";
import {
    RELEASE_ARTIFACT_NAMES,
    RELEASE_LAYOUT_VERSION,
    VERA_PRODUCT_VERSION,
    serializeReleaseManifest,
} from "../../src/release/manifest.ts";
import { readStampedRelease } from "../../src/release/stamp.ts";
import {
    recoverInterruptedUpgrade,
    upgradeLocalInstall,
    writeUpgradeJournal,
} from "../../src/release/upgrade.ts";

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

test("upgradeLocalInstall moves current from the previous release to the new one", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-upgrade-ok-"));
    try {
        const previous = writeDummyRelease(prefix, "vera-old");
        activateRelease(previous, prefix);
        const next = writeDummyRelease(prefix, "vera-new");
        const started: string[] = [];
        const result = await upgradeLocalInstall({
            prefix,
            pack: async () => ({
                prefix,
                releaseRoot: next,
                manifest: readStampedRelease(next),
            }),
            verify: () => undefined,
            drainHost: async () => "absent",
            startHost: async (root) => {
                started.push(root);
            },
        });
        expect(result.fromBuildId).toBe("vera-old");
        expect(result.manifest.build_id).toBe("vera-new");
        expect(readlinkSync(currentSymlinkPath(prefix))).toBe("releases/vera-new");
        expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
        expect(existsSync(previous)).toBe(true);
        expect(started).toEqual([]);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("upgradeLocalInstall restarts a drained host from the new release", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-upgrade-restart-"));
    try {
        const previous = writeDummyRelease(prefix, "vera-old");
        activateRelease(previous, prefix);
        const next = writeDummyRelease(prefix, "vera-new");
        const started: string[] = [];
        await upgradeLocalInstall({
            prefix,
            pack: async () => ({
                prefix,
                releaseRoot: next,
                manifest: readStampedRelease(next),
            }),
            verify: () => undefined,
            drainHost: async () => "stopped",
            startHost: async (root) => {
                started.push(root);
            },
        });
        expect(currentReleaseBuildId(prefix)).toBe("vera-new");
        expect(started).toEqual([next]);
        expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("a verify failure leaves the previous release active", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-upgrade-verify-"));
    try {
        const previous = writeDummyRelease(prefix, "vera-old");
        activateRelease(previous, prefix);
        const next = writeDummyRelease(prefix, "vera-new");
        let packed = false;
        await expect(upgradeLocalInstall({
            prefix,
            pack: async () => {
                packed = true;
                return {
                    prefix,
                    releaseRoot: next,
                    manifest: readStampedRelease(next),
                };
            },
            verify: () => {
                throw new Error("annex digest mismatch");
            },
            drainHost: async () => "absent",
            startHost: async () => {
                throw new Error("startHost must not run");
            },
        })).rejects.toThrow(/annex digest mismatch/);
        expect(packed).toBe(true);
        expect(currentReleaseBuildId(prefix)).toBe("vera-old");
        expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
        expect(existsSync(next)).toBe(true);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("a start failure restores the previous release and restarts it", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-upgrade-start-"));
    try {
        const previous = writeDummyRelease(prefix, "vera-old");
        activateRelease(previous, prefix);
        const next = writeDummyRelease(prefix, "vera-new");
        const started: string[] = [];
        await expect(upgradeLocalInstall({
            prefix,
            pack: async () => ({
                prefix,
                releaseRoot: next,
                manifest: readStampedRelease(next),
            }),
            verify: () => undefined,
            drainHost: async () => "stopped",
            startHost: async (root) => {
                started.push(root);
                if (root === next) {
                    throw new Error("new host refused to boot");
                }
            },
        })).rejects.toThrow(/new host refused to boot/);
        expect(currentReleaseBuildId(prefix)).toBe("vera-old");
        expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
        expect(started[0]).toBe(next);
        expect(started[1]).toBe(previous);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("a drain that cannot stop the host leaves the previous release active", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-upgrade-drain-"));
    try {
        const previous = writeDummyRelease(prefix, "vera-old");
        activateRelease(previous, prefix);
        const next = writeDummyRelease(prefix, "vera-new");
        await expect(upgradeLocalInstall({
            prefix,
            pack: async () => ({
                prefix,
                releaseRoot: next,
                manifest: readStampedRelease(next),
            }),
            verify: () => undefined,
            drainHost: async () => {
                throw new Error(
                    "Resident Vera host PID 9 is still running. "
                        + "The previous release is still active.",
                );
            },
            startHost: async () => {
                throw new Error("startHost must not run");
            },
        })).rejects.toThrow(/still running/);
        expect(currentReleaseBuildId(prefix)).toBe("vera-old");
        expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("recoverInterruptedUpgrade starts the new host after an interrupted start", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-upgrade-recover-new-"));
    try {
        const previous = writeDummyRelease(prefix, "vera-old");
        activateRelease(previous, prefix);
        const next = writeDummyRelease(prefix, "vera-new");
        activateRelease(next, prefix);
        writeUpgradeJournal({
            phase: "starting",
            from_build_id: "vera-old",
            to_build_id: "vera-new",
            host_was_running: true,
        }, prefix);
        const started: string[] = [];
        const recovered = await recoverInterruptedUpgrade({
            prefix,
            startHost: async (root) => {
                started.push(root);
            },
        });
        expect(recovered.recovered).toBe(true);
        expect(recovered.buildId).toBe("vera-new");
        expect(started).toEqual([next]);
        expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("recoverInterruptedUpgrade starts the previous host after an interrupted drain", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-upgrade-recover-old-"));
    try {
        const previous = writeDummyRelease(prefix, "vera-old");
        activateRelease(previous, prefix);
        writeDummyRelease(prefix, "vera-new");
        writeUpgradeJournal({
            phase: "draining",
            from_build_id: "vera-old",
            to_build_id: "vera-new",
            host_was_running: true,
        }, prefix);
        const started: string[] = [];
        const recovered = await recoverInterruptedUpgrade({
            prefix,
            startHost: async (root) => {
                started.push(root);
            },
        });
        expect(recovered.recovered).toBe(true);
        expect(recovered.buildId).toBe("vera-old");
        expect(started).toEqual([previous]);
        expect(currentReleaseBuildId(prefix)).toBe("vera-old");
        expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});
