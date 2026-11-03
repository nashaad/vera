import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { activateRelease } from "../../src/release/activate.ts";
import { currentReleaseBuildId, upgradeJournalPath } from "../../src/release/layout.ts";
import {
    isAlive,
    makeRoot,
    readLockBuild,
    runCleanups,
    runDefaultUpgrade,
    spawnDisposable,
    spawnedPids,
    waitUntilGone,
    writeLock,
    writeRelease,
} from "../support/fake-host-release.ts";

// A real drain, not a mock: these upgrades run with no drainHost or startHost
// override, the same as `bun run install:local` and `vera rollback` do. The
// host lock in each test names a real process: the bun test runner itself (a
// true ancestor of the spawned upgrade process) or a disposable sibling (not
// its ancestor).

afterEach(runCleanups);

test("an install refuses when the lockfile's host is an ancestor of this process, and changes nothing", async () => {
    const root = makeRoot();
    const privateHome = join(root, "private-home");
    const prefix = join(root, "test-prefix");
    writeLock(privateHome, { pid: process.pid, buildId: "vera-old" });
    const old = writeRelease(prefix, "vera-old", privateHome, "publish");
    activateRelease(old.root, prefix);
    const next = writeRelease(prefix, "vera-new", privateHome, "publish");

    const ran = await runDefaultUpgrade({
        mode: "upgrade",
        root,
        prefix,
        releaseRoot: next.root,
        veraHome: privateHome,
    });

    expect(ran.exitCode, ran.stdout).toBe(1);
    expect(ran.stderr).toContain(`host PID ${process.pid}`);
    expect(ran.stderr).toContain("would stop, ending the session before the install finished");
    expect(ran.stderr).toContain("'bun run install:local' from a terminal outside Vera");
    expect(ran.stderr).toContain("The previous release is still active.");
    expect(spawnedPids(next)).toEqual([]);
    expect(readLockBuild(privateHome)).toEqual({ pid: process.pid, build: "vera-old" });
    expect(currentReleaseBuildId(prefix)).toBe("vera-old");
    expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
    expect(isAlive(process.pid)).toBe(true);
});

test("a rollback refuses with rollback wording when the lockfile's host is an ancestor of this process", async () => {
    const root = makeRoot();
    const privateHome = join(root, "private-home");
    const prefix = join(root, "test-prefix");
    writeLock(privateHome, { pid: process.pid, buildId: "vera-old" });
    const old = writeRelease(prefix, "vera-old", privateHome, "publish");
    activateRelease(old.root, prefix);
    const next = writeRelease(prefix, "vera-new", privateHome, "publish");

    const ran = await runDefaultUpgrade({
        mode: "upgrade",
        root,
        prefix,
        releaseRoot: next.root,
        veraHome: privateHome,
        operation: "rollback",
    });

    expect(ran.exitCode, ran.stdout).toBe(1);
    expect(ran.stderr).toContain(`host PID ${process.pid}`);
    expect(ran.stderr).toContain("would stop, ending the session before the rollback finished");
    expect(ran.stderr).toContain("'vera rollback' from a terminal outside Vera");
    expect(ran.stderr).toContain("Nothing was rolled back.");
    expect(currentReleaseBuildId(prefix)).toBe("vera-old");
});

test("an install is not refused when the lockfile names a process that is not an ancestor of this process", async () => {
    const root = makeRoot();
    const privateHome = join(root, "private-home");
    const prefix = join(root, "test-prefix");
    const host = spawnDisposable();
    writeLock(privateHome, { pid: host.pid, buildId: "vera-old" });
    const old = writeRelease(prefix, "vera-old", privateHome, "publish");
    activateRelease(old.root, prefix);
    const next = writeRelease(prefix, "vera-new", privateHome, "publish");

    const ran = await runDefaultUpgrade({
        mode: "upgrade",
        root,
        prefix,
        releaseRoot: next.root,
        veraHome: privateHome,
    });

    expect(ran.exitCode, ran.stderr).toBe(0);
    expect(await waitUntilGone(host.pid)).toBe(true);
    expect(readLockBuild(privateHome).build).toBe("vera-new");
    expect(currentReleaseBuildId(prefix)).toBe("vera-new");
});
