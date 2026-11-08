import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { installRelease } from "../../src/release/install.ts";
import { releaseDirectory } from "../../src/release/layout.ts";
import { defaultRestartRecordPath, listRestartRecords } from "../../src/store/restart-records.ts";
import { defaultEnsureHost } from "../../src/release/upgrade.ts";
import {
    cloneRelease,
    createFixture,
    currentBuild,
    type HandoffFixture,
    processAlive,
    readHostLock,
    stopHostProcess,
    waitUntil,
} from "../support/handoff-e2e.ts";

let fixture: HandoffFixture | undefined;
let previousHome: string | undefined;

afterEach(async () => {
    if (fixture !== undefined) {
        await stopHostProcess(fixture.home).catch(() => undefined);
        fixture.cleanup();
        fixture = undefined;
    }
    if (previousHome === undefined) delete process.env.VERA_HOME;
    else process.env.VERA_HOME = previousHome;
});

test("a host killed after current moves leaves the next start on the target build", async () => {
    fixture = await createFixture();
    const env = fixture;
    previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = env.home;
    const build2 = "vera-e2e-cut";

    await defaultEnsureHost(env.build1Root, { operation: "install" });
    await waitUntil(() => readHostLock(env.home)?.build_id === env.build1, 15_000, "build 1 lock");
    const oldPid = readHostLock(env.home)!.pid;

    const build2Root = cloneRelease(env.build1Root, env.prefix, build2);
    const manifest = JSON.parse(readFileSync(join(build2Root, "manifest.json"), "utf8"));
    const install = installRelease({
        prefix: env.prefix,
        pack: async () => ({ releaseRoot: build2Root, manifest }),
        report: () => {},
    });
    install.catch(() => undefined);

    // The old host moves current and then closes; it is killed in the gap before
    // the target host is started and publishes its lock.
    const deadline = Date.now() + 20_000;
    while (currentBuild(env.prefix) !== build2) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for current to move");
        await Bun.sleep(1);
    }
    process.kill(oldPid, "SIGKILL");
    await waitUntil(() => !processAlive(oldPid), 10_000, "the old host to die");
    expect(currentBuild(env.prefix)).toBe(build2);
    expect(readHostLock(env.home)?.build_id).toBe(env.build1);

    await defaultEnsureHost(releaseDirectory(currentBuild(env.prefix), env.prefix));
    await waitUntil(() => readHostLock(env.home)?.build_id === build2, 30_000, "build 2 lock");
    const lock = readHostLock(env.home)!;
    expect(processAlive(lock.pid)).toBe(true);
    expect(lock.pid).not.toBe(oldPid);
    expect(currentBuild(env.prefix)).toBe(build2);
    expect(listRestartRecords(defaultRestartRecordPath(env.home)).filter(
        (record) => record.cause === "crash",
    )).toEqual([]);
}, 120_000);
