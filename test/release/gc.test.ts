import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gcReleases, ReleaseInUseError, removeRelease } from "../../src/release/gc.ts";
import {
    currentSymlinkPath,
    releaseDirectory,
    rollbackSymlinkPath,
    veraShareRoot,
} from "../../src/release/layout.ts";

function writeRelease(prefix: string, buildId: string): string {
    const root = releaseDirectory(buildId, prefix);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "vera"), "#!/bin/sh\n");
    return root;
}

function writeCurrent(prefix: string, buildId: string): void {
    mkdirSync(veraShareRoot(prefix), { recursive: true });
    symlinkSync(join("releases", buildId), currentSymlinkPath(prefix));
}

test("removeRelease refuses a referenced activated build", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-gc-refuse-"));
    try {
        writeRelease(prefix, "vera-keep");
        writeRelease(prefix, "vera-drop");
        writeCurrent(prefix, "vera-keep");
        expect(() => removeRelease("vera-keep", prefix)).toThrow(ReleaseInUseError);
        expect(existsSync(releaseDirectory("vera-keep", prefix))).toBe(true);
        removeRelease("vera-drop", prefix);
        expect(existsSync(releaseDirectory("vera-drop", prefix))).toBe(false);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("removeRelease refuses a rollback-protected build", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-gc-rollback-"));
    try {
        writeRelease(prefix, "vera-pin");
        writeRelease(prefix, "vera-drop");
        mkdirSync(veraShareRoot(prefix), { recursive: true });
        symlinkSync(join("releases", "vera-pin"), rollbackSymlinkPath(prefix));
        expect(() => removeRelease("vera-pin", prefix)).toThrow(ReleaseInUseError);
        expect(existsSync(releaseDirectory("vera-pin", prefix))).toBe(true);
        removeRelease("vera-drop", prefix);
        expect(existsSync(releaseDirectory("vera-drop", prefix))).toBe(false);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("gcReleases deletes only unreferenced builds", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-gc-sweep-"));
    try {
        writeRelease(prefix, "vera-keep");
        writeRelease(prefix, "vera-drop");
        writeCurrent(prefix, "vera-keep");
        expect(gcReleases(prefix)).toEqual(["vera-drop"]);
        expect(existsSync(releaseDirectory("vera-keep", prefix))).toBe(true);
        expect(existsSync(releaseDirectory("vera-drop", prefix))).toBe(false);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});
