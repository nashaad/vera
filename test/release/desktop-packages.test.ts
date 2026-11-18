import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanDesktopPackages } from "../../src/release/desktop-package-gc.ts";
import {
    DESKTOP_PACKAGE_MANIFEST_NAME,
    parseDesktopPackageManifest,
    serializeDesktopPackageManifest,
} from "../../src/release/desktop-package-manifest.ts";
import {
    holdDesktopPackage,
    writeDesktopPackageReference,
} from "../../src/release/desktop-package-references.ts";
import {
    findDesktopPackage,
    installDesktopPackage,
    scanDesktopPackages,
} from "../../src/release/desktop-packages.ts";
import { gcReleases } from "../../src/release/gc.ts";
import {
    currentSymlinkPath,
    desktopPackageDirectory,
    desktopPackageReferencesDirectory,
    desktopPackagesDirectory,
    releaseDirectory,
    rollbackSymlinkPath,
    veraShareRoot,
} from "../../src/release/layout.ts";
import { compareVersions } from "../../src/release/version.ts";
import { compareReleaseVersions } from "../../src/release/version-order.ts";

const HOST = "vera-host-a";

async function withPrefix(run: (prefix: string) => void | Promise<void>): Promise<void> {
    const prefix = mkdtempSync(join(tmpdir(), "vera-desktop-pkg-"));
    try {
        await run(prefix);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
}

function manifestText(hostBuildId: string, desktopVersion: string, entry = "main.js"): string {
    return serializeDesktopPackageManifest({
        layout_version: 1,
        desktop_version: desktopVersion,
        host_build_id: hostBuildId,
        entry,
    });
}

// Writes a complete package straight to its final path, bypassing the installer.
function placePackage(prefix: string, hostBuildId: string, version: string, valid = true): string {
    const directory = desktopPackageDirectory(hostBuildId, version, prefix);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "main.js"), "// entry\n");
    writeFileSync(
        join(directory, DESKTOP_PACKAGE_MANIFEST_NAME),
        valid ? manifestText(hostBuildId, version) : "{ not json",
    );
    return directory;
}

interface TarballOptions {
    readonly hostBuildId?: string;
    readonly manifestVersion?: string;
    readonly withEntry?: boolean;
}

function makeTarball(workDirectory: string, version: string, options: TarballOptions = {}): {
    readonly path: string;
    readonly sha256: string;
} {
    const source = mkdtempSync(join(workDirectory, "src-"));
    writeFileSync(
        join(source, DESKTOP_PACKAGE_MANIFEST_NAME),
        manifestText(options.hostBuildId ?? HOST, options.manifestVersion ?? version),
    );
    if (options.withEntry !== false) writeFileSync(join(source, "main.js"), "// entry\n");
    const path = join(workDirectory, `desktop-${version}.tar.gz`);
    const tar = spawnSync("tar", ["-czf", path, "-C", source, "."]);
    expect(tar.status).toBe(0);
    return { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
}

function activate(prefix: string, current: string, rollback?: string): void {
    mkdirSync(veraShareRoot(prefix), { recursive: true });
    symlinkSync(join("releases", current), currentSymlinkPath(prefix));
    if (rollback !== undefined) symlinkSync(join("releases", rollback), rollbackSymlinkPath(prefix));
}

function deadPid(): number {
    const result = spawnSync(process.execPath, ["-e", ""]);
    expect(result.pid).toBeGreaterThan(0);
    return result.pid;
}

function versionsOf(prefix: string, hostBuildId: string): string[] {
    return existsSync(join(desktopPackagesDirectory(prefix), hostBuildId))
        ? readdirSync(join(desktopPackagesDirectory(prefix), hostBuildId)).sort()
        : [];
}

test("desktop packages live under share/vera/desktop/<host build id>/<version>", () => {
    expect(desktopPackagesDirectory("/p")).toBe(join("/p", "share", "vera", "desktop"));
    expect(desktopPackageDirectory("vera-abc", "1.2.3", "/p")).toBe(
        join("/p", "share", "vera", "desktop", "vera-abc", "1.2.3"),
    );
    expect(desktopPackageReferencesDirectory("/p")).toBe(join("/p", "share", "vera", "desktop", ".loaded"));
});

test("the package manifest refuses anything malformed", () => {
    const good = { layout_version: 1, desktop_version: "0.3.0", host_build_id: "vera-a", entry: "dist/main.js" };
    expect(parseDesktopPackageManifest(JSON.stringify(good))).toEqual(good);
    const refused: readonly [string, Record<string, unknown>][] = [
        ["layout_version", { ...good, layout_version: 2 }],
        ["desktop_version", { ...good, desktop_version: "latest" }],
        ["desktop_version", { ...good, desktop_version: undefined }],
        ["host_build_id", { ...good, host_build_id: "../vera-a" }],
        ["host_build_id", { ...good, host_build_id: ".hidden" }],
        ["host_build_id", { ...good, host_build_id: "" }],
        ["entry", { ...good, entry: "../main.js" }],
        ["entry", { ...good, entry: "/etc/passwd" }],
        ["entry", { ...good, entry: "a/../main.js" }],
        ["entry", { ...good, entry: "a\\main.js" }],
        ["entry", { ...good, entry: undefined }],
    ];
    for (const [field, value] of refused) {
        expect(() => parseDesktopPackageManifest(JSON.stringify(value))).toThrow(field);
    }
    expect(() => parseDesktopPackageManifest("{ not json")).toThrow("not JSON");
    expect(() => parseDesktopPackageManifest("[]")).toThrow("root");
});

test("@core a desktop package installs from a tarball with the right hash and installing it again changes nothing", async () => {
    await withPrefix(async (prefix) => {
        const tarball = makeTarball(prefix, "0.4.0");
        const installed = await installDesktopPackage({
            tarball: tarball.path,
            sha256: tarball.sha256.toUpperCase(),
            hostBuildId: HOST,
            desktopVersion: "0.4.0",
            prefix,
        });
        const directory = desktopPackageDirectory(HOST, "0.4.0", prefix);
        expect(installed.installed).toBe(true);
        expect(installed.package.directory).toBe(directory);
        expect(readFileSync(installed.package.entryPath, "utf8")).toBe("// entry\n");
        expect(versionsOf(prefix, HOST)).toEqual(["0.4.0"]);

        writeFileSync(join(directory, "marker"), "kept");
        const again = await installDesktopPackage({
            tarball: join(prefix, "no-such-file.tar.gz"),
            sha256: tarball.sha256,
            hostBuildId: HOST,
            desktopVersion: "0.4.0",
            prefix,
        });
        expect(again.installed).toBe(false);
        expect(readFileSync(join(directory, "marker"), "utf8")).toBe("kept");
        expect(findDesktopPackage(HOST, prefix)?.desktopVersion).toBe("0.4.0");
    });
});

test("a tarball whose hash differs is refused and writes nothing", async () => {
    await withPrefix(async (prefix) => {
        const tarball = makeTarball(prefix, "0.4.0");
        const wrong = createHash("sha256").update("other").digest("hex");
        await expect(installDesktopPackage({
            tarball: tarball.path,
            sha256: wrong,
            hostBuildId: HOST,
            desktopVersion: "0.4.0",
            prefix,
        })).rejects.toThrow("Checksum mismatch");
        expect(existsSync(desktopPackagesDirectory(prefix))).toBe(false);
        await expect(installDesktopPackage({
            tarball: tarball.path,
            sha256: "abc",
            hostBuildId: HOST,
            desktopVersion: "0.4.0",
            prefix,
        })).rejects.toThrow("not a SHA-256");
    });
});

test("a package that names another host build or version is refused", async () => {
    await withPrefix(async (prefix) => {
        const otherHost = makeTarball(prefix, "0.4.0", { hostBuildId: "vera-host-b" });
        await expect(installDesktopPackage({
            tarball: otherHost.path,
            sha256: otherHost.sha256,
            hostBuildId: HOST,
            desktopVersion: "0.4.0",
            prefix,
        })).rejects.toThrow("targets host build vera-host-b");
        const otherVersion = makeTarball(prefix, "0.4.0", { manifestVersion: "0.5.0" });
        await expect(installDesktopPackage({
            tarball: otherVersion.path,
            sha256: otherVersion.sha256,
            hostBuildId: HOST,
            desktopVersion: "0.4.0",
            prefix,
        })).rejects.toThrow("is version 0.5.0");
        expect(versionsOf(prefix, HOST)).toEqual([]);
        expect(findDesktopPackage(HOST, prefix)).toBeUndefined();
        await expect(installDesktopPackage({
            tarball: otherHost.path,
            sha256: otherHost.sha256,
            hostBuildId: "../escape",
            desktopVersion: "0.4.0",
            prefix,
        })).rejects.toThrow("cannot name a host build directory");
    });
});

test("@core a failed install leaves nothing at the final path or beside it", async () => {
    await withPrefix(async (prefix) => {
        const noEntry = makeTarball(prefix, "0.4.0", { withEntry: false });
        await expect(installDesktopPackage({
            tarball: noEntry.path,
            sha256: noEntry.sha256,
            hostBuildId: HOST,
            desktopVersion: "0.4.0",
            prefix,
        })).rejects.toThrow("no usable entry");

        const corrupt = join(prefix, "corrupt.tar.gz");
        writeFileSync(corrupt, "this is not a gzip archive");
        await expect(installDesktopPackage({
            tarball: corrupt,
            sha256: createHash("sha256").update(readFileSync(corrupt)).digest("hex"),
            hostBuildId: HOST,
            desktopVersion: "0.4.0",
            prefix,
        })).rejects.toThrow("Could not unpack");

        expect(versionsOf(prefix, HOST)).toEqual([]);
        expect(findDesktopPackage(HOST, prefix)).toBeUndefined();
    });
});

test("an install replaces a directory at the final path that holds no usable package", async () => {
    await withPrefix(async (prefix) => {
        placePackage(prefix, HOST, "0.4.0", false);
        const tarball = makeTarball(prefix, "0.4.0");
        const installed = await installDesktopPackage({
            tarball: tarball.path,
            sha256: tarball.sha256,
            hostBuildId: HOST,
            desktopVersion: "0.4.0",
            prefix,
        });
        expect(installed.installed).toBe(true);
        expect(findDesktopPackage(HOST, prefix)?.desktopVersion).toBe("0.4.0");
    });
});

test("lookup returns the newest valid package and skips unusable directories", async () => {
    await withPrefix((prefix) => {
        for (const version of ["0.2.0", "0.10.0", "0.9.0", "1.0.0-beta.1"]) placePackage(prefix, HOST, version);
        placePackage(prefix, HOST, "9.0.0", false);
        const lying = placePackage(prefix, HOST, "8.0.0");
        writeFileSync(join(lying, DESKTOP_PACKAGE_MANIFEST_NAME), manifestText(HOST, "7.0.0"));
        const wrongHost = placePackage(prefix, HOST, "6.0.0");
        writeFileSync(join(wrongHost, DESKTOP_PACKAGE_MANIFEST_NAME), manifestText("vera-host-b", "6.0.0"));
        const noEntry = placePackage(prefix, HOST, "5.0.0");
        rmSync(join(noEntry, "main.js"));
        mkdirSync(join(desktopPackagesDirectory(prefix), HOST, ".tmp-1-abc"));
        mkdirSync(join(desktopPackagesDirectory(prefix), HOST, "not-a-version"));

        expect(findDesktopPackage(HOST, prefix)?.desktopVersion).toBe("1.0.0-beta.1");
        const scan = scanDesktopPackages(HOST, prefix);
        expect(scan.valid.map((item) => item.desktopVersion)).toEqual(["1.0.0-beta.1", "0.10.0", "0.9.0", "0.2.0"]);
        expect([...scan.invalid].sort()).toEqual(["5.0.0", "6.0.0", "8.0.0", "9.0.0", "not-a-version"]);
        expect(findDesktopPackage("vera-host-none", prefix)).toBeUndefined();
        expect(findDesktopPackage("../vera-host-a", prefix)).toBeUndefined();
    });
});

test("version order matches Bun.semver", () => {
    const versions = [
        "0.0.1", "0.1.0", "0.9.0", "0.10.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta",
        "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "2.0.0", "10.0.0",
        "1.0.0+build.5",
    ];
    for (const left of versions) {
        for (const right of versions) {
            expect(compareReleaseVersions(left, right)).toBe(compareVersions(left, right) as -1 | 0 | 1);
        }
    }
    expect(() => compareReleaseVersions("latest", "1.0.0")).toThrow("Invalid version");
});

test("cleanup keeps the newest package of the current and rollback host builds and removes the rest", async () => {
    await withPrefix((prefix) => {
        activate(prefix, "vera-cur", "vera-old");
        for (const version of ["0.1.0", "0.2.0", "0.3.0"]) {
            placePackage(prefix, "vera-cur", version);
            placePackage(prefix, "vera-old", version);
            placePackage(prefix, "vera-retained", version);
        }
        placePackage(prefix, "vera-cur", "0.4.0", false);
        const removed = [...cleanDesktopPackages(prefix)];

        expect(versionsOf(prefix, "vera-cur")).toEqual(["0.3.0"]);
        expect(versionsOf(prefix, "vera-old")).toEqual(["0.3.0"]);
        expect(existsSync(join(desktopPackagesDirectory(prefix), "vera-retained"))).toBe(false);
        expect(removed.sort()).toEqual([
            "vera-cur/0.1.0", "vera-cur/0.2.0", "vera-cur/0.4.0",
            "vera-old/0.1.0", "vera-old/0.2.0",
            "vera-retained/0.1.0", "vera-retained/0.2.0", "vera-retained/0.3.0",
        ]);
        expect(cleanDesktopPackages(prefix)).toEqual([]);
    });
});

test("cleanup removes the packages of a host build that is gone and the empty directory it leaves", async () => {
    await withPrefix((prefix) => {
        activate(prefix, "vera-cur");
        mkdirSync(releaseDirectory("vera-cur", prefix), { recursive: true });
        placePackage(prefix, "vera-cur", "0.3.0");
        placePackage(prefix, "vera-gone", "0.1.0");
        placePackage(prefix, "vera-gone", "0.2.0");
        expect(existsSync(releaseDirectory("vera-gone", prefix))).toBe(false);

        expect([...cleanDesktopPackages(prefix)].sort()).toEqual(["vera-gone/0.1.0", "vera-gone/0.2.0"]);
        expect(readdirSync(desktopPackagesDirectory(prefix))).toEqual(["vera-cur"]);
        expect(versionsOf(prefix, "vera-cur")).toEqual(["0.3.0"]);
    });
});

test("cleanup with no current release keeps only what a running desktop holds", async () => {
    await withPrefix((prefix) => {
        placePackage(prefix, HOST, "0.1.0");
        expect(cleanDesktopPackages(prefix)).toEqual(["vera-host-a/0.1.0"]);
        expect(cleanDesktopPackages(join(prefix, "nowhere"))).toEqual([]);
    });
});

test("@core cleanup spares a package a running desktop holds and drops it after the desktop releases it", async () => {
    await withPrefix((prefix) => {
        activate(prefix, "vera-cur");
        placePackage(prefix, "vera-cur", "0.3.0");
        placePackage(prefix, "vera-gone", "0.1.0");
        placePackage(prefix, "vera-gone", "0.2.0");
        const loaded = findDesktopPackage("vera-gone", prefix);
        if (loaded === undefined) throw new Error("the package was not found");
        expect(loaded.desktopVersion).toBe("0.2.0");

        const release = holdDesktopPackage(loaded, prefix);
        expect(cleanDesktopPackages(prefix)).toEqual(["vera-gone/0.1.0"]);
        expect(versionsOf(prefix, "vera-gone")).toEqual(["0.2.0"]);
        expect(versionsOf(prefix, "vera-cur")).toEqual(["0.3.0"]);

        release();
        expect(readdirSync(desktopPackageReferencesDirectory(prefix))).toEqual([]);
        expect(cleanDesktopPackages(prefix)).toEqual(["vera-gone/0.2.0"]);
    });
});

test("a record of an exited desktop, or of a PID another program now holds, protects nothing", async () => {
    await withPrefix((prefix) => {
        placePackage(prefix, "vera-gone", "0.1.0");
        placePackage(prefix, "vera-gone", "0.2.0");
        const exited = deadPid();
        writeDesktopPackageReference({
            pid: exited,
            started_at: new Date().toISOString(),
            host_build_id: "vera-gone",
            desktop_version: "0.1.0",
        }, prefix);
        writeDesktopPackageReference({
            pid: process.pid,
            started_at: "2001-01-01T00:00:00.000Z",
            host_build_id: "vera-gone",
            desktop_version: "0.2.0",
        }, prefix);

        expect([...cleanDesktopPackages(prefix)].sort()).toEqual(["vera-gone/0.1.0", "vera-gone/0.2.0"]);
        expect(readdirSync(desktopPackageReferencesDirectory(prefix))).toEqual([]);
    });
});

test("cleanup keeps every package while a live desktop's record cannot be read", async () => {
    await withPrefix((prefix) => {
        placePackage(prefix, "vera-gone", "0.1.0");
        mkdirSync(desktopPackageReferencesDirectory(prefix), { recursive: true });
        writeFileSync(join(desktopPackageReferencesDirectory(prefix), `${process.pid}.json`), "{\"pid\":");
        const reasons: string[] = [];

        expect(cleanDesktopPackages(prefix, { onHeld: (reason) => reasons.push(reason) })).toEqual([]);
        expect(versionsOf(prefix, "vera-gone")).toEqual(["0.1.0"]);
        expect(reasons).toHaveLength(1);

        rmSync(join(desktopPackageReferencesDirectory(prefix), `${process.pid}.json`));
        expect(cleanDesktopPackages(prefix)).toEqual(["vera-gone/0.1.0"]);
    });
});

test("holding a package that was collected first throws and leaves no record", async () => {
    await withPrefix((prefix) => {
        const directory = placePackage(prefix, HOST, "0.1.0");
        const found = findDesktopPackage(HOST, prefix);
        if (found === undefined) throw new Error("the package was not found");
        rmSync(directory, { recursive: true });

        expect(() => holdDesktopPackage(found, prefix)).toThrow("no readable manifest");
        expect(readdirSync(desktopPackageReferencesDirectory(prefix))).toEqual([]);
    });
});

test("cleanup removes install and collection directories of exited processes and leaves live ones", async () => {
    await withPrefix((prefix) => {
        activate(prefix, HOST);
        placePackage(prefix, HOST, "0.1.0");
        const host = join(desktopPackagesDirectory(prefix), HOST);
        const exited = deadPid();
        mkdirSync(join(host, `.tmp-${exited}-ab12`));
        mkdirSync(join(host, `.gc-${exited}-0.0.9`));
        mkdirSync(join(host, `.tmp-${process.pid}-cd34`));

        expect(cleanDesktopPackages(prefix)).toEqual([]);
        expect(readdirSync(host).sort()).toEqual([`.tmp-${process.pid}-cd34`, "0.1.0"]);
    });
});

test("release garbage collection also cleans desktop packages", async () => {
    await withPrefix((prefix) => {
        mkdirSync(releaseDirectory("vera-cur", prefix), { recursive: true });
        writeFileSync(join(releaseDirectory("vera-cur", prefix), "vera"), "#!/bin/sh\n");
        activate(prefix, "vera-cur");
        placePackage(prefix, "vera-cur", "0.1.0");
        placePackage(prefix, "vera-cur", "0.2.0");
        placePackage(prefix, "vera-gone", "0.1.0");

        gcReleases(prefix, { listProcessExecutables: () => [] });

        expect(versionsOf(prefix, "vera-cur")).toEqual(["0.2.0"]);
        expect(existsSync(join(desktopPackagesDirectory(prefix), "vera-gone"))).toBe(false);
    });
});
