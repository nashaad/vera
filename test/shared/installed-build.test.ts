import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    assertInstalledBuild,
    installedBuildAtPrefix,
    installedBuildChangedMessage,
    installedBuildMismatch,
    InstalledBuildChangedError,
} from "../../clients/shared/installed-build.ts";

test("@core a client is refused only when both builds are known and differ", () => {
    expect(installedBuildMismatch("old", "new")).toEqual({ clientBuildId: "old", installedBuildId: "new" });
    expect(installedBuildMismatch("same", "same")).toBeUndefined();
    expect(installedBuildMismatch(undefined, "new")).toBeUndefined();
    expect(installedBuildMismatch("old", undefined)).toBeUndefined();
});

test("@core both clients word the refusal alike and name themselves", () => {
    const mismatch = { clientBuildId: "old", installedBuildId: "new" };
    expect(installedBuildChangedMessage("TUI", mismatch)).toBe(
        "The installed Vera is now build new, and this TUI is build old. Quit and reopen Vera to continue.",
    );
    expect(installedBuildChangedMessage("desktop app", mismatch)).toBe(
        "The installed Vera is now build new, and this desktop app is build old. Quit and reopen Vera to continue.",
    );
});

test("assertInstalledBuild throws the build ids it was given", () => {
    expect(() => assertInstalledBuild("same", "same")).not.toThrow();
    expect(() => assertInstalledBuild("old", undefined)).not.toThrow();
    try {
        assertInstalledBuild("old", "new");
        throw new Error("The mismatch was not refused.");
    } catch (error) {
        expect(error).toBeInstanceOf(InstalledBuildChangedError);
        expect(error).toMatchObject({ clientBuildId: "old", installedBuildId: "new" });
    }
});

test("the installed build is read from the current link of a prefix", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-installed-build-"));
    try {
        expect(installedBuildAtPrefix(prefix)).toBeUndefined();
        const share = join(prefix, "share", "vera");
        mkdirSync(join(share, "releases", "build-2"), { recursive: true });
        symlinkSync("releases/build-2", join(share, "current"));
        expect(installedBuildAtPrefix(prefix)).toBe("build-2");
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});
