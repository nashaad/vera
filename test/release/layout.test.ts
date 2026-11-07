import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import {
    childReleaseRoot,
    currentReleaseBuildId,
    currentSymlinkPath,
    defaultInstallPrefix,
    launcherPath,
    rollbackReleaseBuildId,
    rollbackSymlinkPath,
    packedAnnexRoot,
    packedReleaseRoot,
    releaseBinaryPath,
    releaseDirectory,
    RELEASE_ANNEX_NAME,
    releaseManifestPath,
    releasesDirectory,
    checkoutPackRoot,
    thisProcessReleaseRoot,
    upgradeJournalPath,
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
    expect(rollbackSymlinkPath(prefix)).toBe(join(prefix, "share", "vera", "rollback"));
    expect(upgradeJournalPath(prefix)).toBe(
        join(prefix, "share", "vera", "upgrade.json"),
    );
    expect(rollbackReleaseBuildId("/tmp/vera-no-such-prefix")).toBeUndefined();
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

test("currentReleaseBuildId reads the symlink text and nothing else", () => {
    expect(currentReleaseBuildId("/tmp/vera-no-such-prefix")).toBeUndefined();
});

test("a development instance uses the checkout pack when current is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-dev-pack-"));
    const previous = process.env.VERA_DEV_INSTANCE;
    const prefix = join(root, "prefix");
    const checkout = join(root, "checkout");
    const checkoutPack = join(checkout, "dist", "release");
    mkdirSync(checkoutPack, { recursive: true });
    writeFileSync(join(checkoutPack, "manifest.json"), "{}\n");
    try {
        process.env.VERA_DEV_INSTANCE = "ovu30 vera-test";
        expect(thisProcessReleaseRoot(prefix, join(root, "bun"), checkout)).toBe(
            checkoutPack,
        );
        delete process.env.VERA_DEV_INSTANCE;
        expect(thisProcessReleaseRoot(prefix, join(root, "bun"), checkout)).toBe(
            join(prefix, "share", "vera", "current"),
        );
    } finally {
        if (previous === undefined) {
            delete process.env.VERA_DEV_INSTANCE;
        } else {
            process.env.VERA_DEV_INSTANCE = previous;
        }
        rmSync(root, { recursive: true, force: true });
    }
});

test("the checkout pack defaults to the working directory", () => {
    expect(checkoutPackRoot()).toBe(join(process.cwd(), "dist", "release"));
    expect(checkoutPackRoot("/work/tree")).toBe(join("/work/tree", "dist", "release"));
});

test("childReleaseRoot never names the installed release for a development instance", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-child-root-"));
    const previous = process.env.VERA_DEV_INSTANCE;
    const prefix = join(root, "prefix");
    const installed = join(prefix, "share", "vera", "current");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "manifest.json"), "{}\n");
    const checkout = join(root, "checkout");
    try {
        process.env.VERA_DEV_INSTANCE = "ovu30 vera-test";
        expect(childReleaseRoot(prefix, join(root, "bun"), checkout)).toBeUndefined();

        const checkoutPack = join(checkout, "dist", "release");
        mkdirSync(checkoutPack, { recursive: true });
        writeFileSync(join(checkoutPack, "manifest.json"), "{}\n");
        expect(childReleaseRoot(prefix, join(root, "bun"), checkout)).toBe(
            checkoutPack,
        );

        const packedClient = join(root, "packed");
        mkdirSync(packedClient, { recursive: true });
        writeFileSync(join(packedClient, "manifest.json"), "{}\n");
        expect(childReleaseRoot(prefix, join(packedClient, "vera"))).toBe(
            packedClient,
        );

        expect(childReleaseRoot(prefix, join(installed, "vera"))).toBeUndefined();

        delete process.env.VERA_DEV_INSTANCE;
        expect(childReleaseRoot(prefix, join(root, "bun"), checkout)).toBe(installed);
    } finally {
        if (previous === undefined) delete process.env.VERA_DEV_INSTANCE;
        else process.env.VERA_DEV_INSTANCE = previous;
        rmSync(root, { recursive: true, force: true });
    }
});
