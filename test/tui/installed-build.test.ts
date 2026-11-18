import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedBuildId } from "../../clients/tui/installed-build.ts";

test("the current build is read from the TUI release's private prefix", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-prefix-"));
    try {
        const share = join(root, "share", "vera");
        const oldRelease = join(share, "releases", "old-build");
        mkdirSync(oldRelease, { recursive: true });
        symlinkSync("releases/new-build", join(share, "current"));
        expect(installedBuildId(oldRelease)).toBe("new-build");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
