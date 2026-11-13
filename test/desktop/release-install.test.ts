import { afterEach, expect, test } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    BUNDLED_RELEASE_TARBALL,
    decideInstall,
    installBundledRelease,
} from "../../clients/desktop/src/release-install.ts";
import { compareReleaseVersions } from "../../src/release/version-order.ts";
import {
    currentReleaseBuildId,
    launcherPath,
    releaseDirectory,
    releasesDirectory,
    rollbackReleaseBuildId,
} from "../../src/release/layout.ts";
import { fixtureManifest, writeFixtureBundle, type FixtureRelease } from "../support/packed-release-fixture.ts";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Scratch {
    readonly prefix: string;
    readonly bundle: string;
}

function scratch(): Scratch {
    const root = mkdtempSync(join(tmpdir(), "vera-desktop-install-"));
    roots.push(root);
    return { prefix: join(root, "prefix"), bundle: join(root, "bundle") };
}

function release(buildId: string, productVersion: string, builtAt = "2026-11-01T00:00:00.000Z"): FixtureRelease {
    return { buildId, productVersion, builtAt };
}

async function install(where: Scratch, bundled: FixtureRelease) {
    rmSync(where.bundle, { recursive: true, force: true });
    writeFixtureBundle(where.bundle, bundled);
    return installBundledRelease({ bundleDirectory: where.bundle, prefix: where.prefix });
}

function runLauncher(prefix: string): number | null {
    return spawnSync(launcherPath(prefix), ["boot"]).status;
}

test("compareReleaseVersions agrees with Bun.semver.order", () => {
    const versions = [
        "0.0.1", "0.1.0", "0.1.0-alpha", "0.1.0-alpha.1", "0.1.0-alpha.2", "0.1.0-alpha.beta",
        "0.1.0-beta", "0.1.0-beta.2", "0.1.0-beta.11", "0.1.0-rc.1", "0.1.0+build.5", "0.1.0-1",
        "0.1.0-alpha.1.2", "0.2.0", "0.10.0", "1.0.0", "1.0.0-0", "1.0.1", "2.0.0", "10.0.0",
    ];
    for (const left of versions) {
        for (const right of versions) {
            expect([left, right, compareReleaseVersions(left, right)])
                .toEqual([left, right, Bun.semver.order(left, right)]);
        }
    }
});

test("compareReleaseVersions refuses text that is not a version", () => {
    expect(() => compareReleaseVersions("0.1", "0.1.0")).toThrow(/Invalid version/);
    expect(() => compareReleaseVersions("0.1.0", "latest")).toThrow(/Invalid version/);
});

test("decideInstall installs when nothing is installed or the bundle is newer", () => {
    const bundled = fixtureManifest(release("vera-b", "0.2.0"), "sha256:x");
    expect(decideInstall(bundled, undefined)).toBe("missing");
    expect(decideInstall(bundled, fixtureManifest(release("vera-a", "0.1.0"), "sha256:x"))).toBe("older");
});

test("decideInstall keeps the installed release when it is the same or newer", () => {
    const bundled = fixtureManifest(release("vera-b", "0.2.0"), "sha256:x");
    expect(decideInstall(bundled, fixtureManifest(release("vera-b", "0.2.0"), "sha256:x"))).toBe("keep");
    expect(decideInstall(bundled, fixtureManifest(release("vera-a", "0.3.0"), "sha256:x"))).toBe("keep");
    expect(decideInstall(bundled, fixtureManifest(release("vera-a", "0.2.0-rc.1"), "sha256:x"))).toBe("older");
});

test("decideInstall breaks a version tie by build time", () => {
    const bundled = fixtureManifest(release("vera-b", "0.1.0", "2026-11-02T00:00:00.000Z"), "sha256:x");
    const earlier = fixtureManifest(release("vera-a", "0.1.0", "2026-11-01T00:00:00.000Z"), "sha256:x");
    const later = fixtureManifest(release("vera-c", "0.1.0", "2026-11-03T00:00:00.000Z"), "sha256:x");
    expect(decideInstall(bundled, earlier)).toBe("older");
    expect(decideInstall(bundled, later)).toBe("keep");
});

test("@core a missing vera command is installed from the bundled release", async () => {
    const where = scratch();
    const outcome = await install(where, release("vera-first", "0.1.0"));
    expect(outcome).toEqual({ kind: "installed", buildId: "vera-first", reason: "missing" });
    expect(currentReleaseBuildId(where.prefix)).toBe("vera-first");
    expect(readlinkSync(join(where.prefix, "share", "vera", "current"))).toBe("releases/vera-first");
    expect(runLauncher(where.prefix)).toBe(0);
    expect(readdirSync(releasesDirectory(where.prefix)).filter((name) => name.startsWith("."))).toEqual([]);
});

test("a vera command older than the bundle is replaced and becomes the rollback", async () => {
    const where = scratch();
    await install(where, release("vera-old", "0.1.0"));
    const outcome = await install(where, release("vera-new", "0.2.0"));
    expect(outcome).toEqual({ kind: "installed", buildId: "vera-new", reason: "older" });
    expect(currentReleaseBuildId(where.prefix)).toBe("vera-new");
    expect(rollbackReleaseBuildId(where.prefix)).toBe("vera-old");
    expect(runLauncher(where.prefix)).toBe(0);
});

test("a vera command that is the same or newer is left alone", async () => {
    const where = scratch();
    await install(where, release("vera-new", "0.2.0"));
    const launcherBefore = readFileSync(launcherPath(where.prefix), "utf8");

    expect(await install(where, release("vera-new", "0.2.0"))).toEqual({ kind: "kept", buildId: "vera-new" });
    expect(await install(where, release("vera-old", "0.1.0"))).toEqual({ kind: "kept", buildId: "vera-old" });
    expect(currentReleaseBuildId(where.prefix)).toBe("vera-new");
    expect(existsSync(releaseDirectory("vera-old", where.prefix))).toBe(false);
    expect(readFileSync(launcherPath(where.prefix), "utf8")).toBe(launcherBefore);
});

test("an installed command whose release directory is gone is installed again", async () => {
    const where = scratch();
    await install(where, release("vera-new", "0.2.0"));
    rmSync(releaseDirectory("vera-new", where.prefix), { recursive: true });
    const outcome = await install(where, release("vera-new", "0.2.0"));
    expect(outcome).toEqual({ kind: "installed", buildId: "vera-new", reason: "missing" });
    expect(runLauncher(where.prefix)).toBe(0);
});

test("@core a failed install reports the failure and leaves the previous command working", async () => {
    const where = scratch();
    await install(where, release("vera-old", "0.1.0"));
    rmSync(where.bundle, { recursive: true, force: true });
    writeFixtureBundle(where.bundle, release("vera-new", "0.2.0"));
    writeFileSync(join(where.bundle, BUNDLED_RELEASE_TARBALL), "not an archive\n");

    const outcome = await installBundledRelease({ bundleDirectory: where.bundle, prefix: where.prefix });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.message).toContain("does not match its checksum");
    expect(outcome.message).toContain("left as it was");
    expect(currentReleaseBuildId(where.prefix)).toBe("vera-old");
    expect(runLauncher(where.prefix)).toBe(0);
    expect(readdirSync(releasesDirectory(where.prefix)).sort()).toEqual(["vera-old"]);
});

test("a release that fails verification is removed and the previous command keeps working", async () => {
    const where = scratch();
    await install(where, release("vera-old", "0.1.0"));
    const outcome = await install(where, { ...release("vera-new", "0.2.0"), omit: "docs/index.md" });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.message).toContain("missing docs/index.md");
    expect(existsSync(releaseDirectory("vera-new", where.prefix))).toBe(false);
    expect(currentReleaseBuildId(where.prefix)).toBe("vera-old");
    expect(runLauncher(where.prefix)).toBe(0);
    expect(readdirSync(releasesDirectory(where.prefix)).sort()).toEqual(["vera-old"]);
});

test("a failed first install leaves no launcher and says nothing was kept", async () => {
    const where = scratch();
    const outcome = await install(where, { ...release("vera-new", "0.2.0"), omit: "docs/index.md" });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.message).not.toContain("left as it was");
    expect(existsSync(launcherPath(where.prefix))).toBe(false);
    expect(currentReleaseBuildId(where.prefix)).toBeUndefined();
});

test("an app without a bundled release installs nothing", async () => {
    const where = scratch();
    const outcome = await installBundledRelease({ bundleDirectory: where.bundle, prefix: where.prefix });
    expect(outcome).toEqual({ kind: "absent" });
    expect(existsSync(where.prefix)).toBe(false);
});

test("a bundle manifest that cannot be read is reported", async () => {
    const where = scratch();
    writeFixtureBundle(where.bundle, release("vera-new", "0.2.0"));
    writeFileSync(join(where.bundle, "manifest.json"), "{not json");
    const outcome = await installBundledRelease({ bundleDirectory: where.bundle, prefix: where.prefix });
    expect(outcome.kind).toBe("failed");
});

test("staging left by an install killed long ago is removed", async () => {
    const where = scratch();
    await install(where, release("vera-old", "0.1.0"));
    const stale = join(releasesDirectory(where.prefix), ".install-stale");
    const fresh = join(releasesDirectory(where.prefix), ".install-fresh");
    for (const path of [stale, fresh]) {
        spawnSync("mkdir", [path]);
    }
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    utimesSync(stale, longAgo, longAgo);
    await install(where, release("vera-new", "0.2.0"));
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
});
