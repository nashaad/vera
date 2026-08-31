import { expect, test } from "bun:test";
import { join, sep } from "node:path";

import {
    currentSymlinkPath,
    defaultInstallPrefix,
    launcherPath,
    packedAnnexRoot,
    packedReleaseRoot,
    releaseBinaryPath,
    releaseDirectory,
    RELEASE_ANNEX_NAME,
    releaseManifestPath,
    releasesDirectory,
    thisProcessReleaseRoot,
    upgradeJournalPath,
    currentReleaseBuildId,
    veraShareRoot,
} from "../../src/release/layout.ts";

test("the activated release lives under ~/.local/share/vera/current", () => {
    const prefix = defaultInstallPrefix();
    expect(prefix).toBe(join(process.env.HOME as string, ".local"));
    expect(veraShareRoot(prefix)).toBe(join(prefix, "share", "vera"));
    expect(releasesDirectory(prefix)).toBe(join(prefix, "share", "vera", "releases"));
    expect(releaseDirectory("vera-abc", prefix)).toBe(
        join(prefix, "share", "vera", "releases", "vera-abc"),
    );
    expect(currentSymlinkPath(prefix)).toBe(join(prefix, "share", "vera", "current"));
    expect(upgradeJournalPath(prefix)).toBe(
        join(prefix, "share", "vera", "upgrade.json"),
    );
    expect(packedReleaseRoot(prefix)).toBe(currentSymlinkPath(prefix));
    expect(launcherPath(prefix)).toBe(join(prefix, "bin", "vera"));
    expect(packedReleaseRoot().split(sep)).not.toContain("dist");
    expect(currentReleaseBuildId("/tmp/vera-no-such-prefix")).toBeUndefined();
});

test("release layout names annex assets and the manifest", () => {
    const root = packedReleaseRoot("/tmp/vera-prefix");
    expect(root).toBe(join("/tmp/vera-prefix", "share", "vera", "current"));
    expect(packedAnnexRoot(root)).toBe(join(root, "annex"));
    expect(releaseManifestPath(root)).toBe(join(root, "manifest.json"));
    expect(releaseBinaryPath(RELEASE_ANNEX_NAME, root)).toBe(
        join(root, RELEASE_ANNEX_NAME),
    );
    expect(packedAnnexRoot(root).split(sep)).not.toContain("web");
    expect(packedAnnexRoot(root).split(sep)).not.toContain("clients");
    expect(packedAnnexRoot()).toBe(join(thisProcessReleaseRoot(), "annex"));
});
