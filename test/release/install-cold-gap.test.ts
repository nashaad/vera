import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { stopResidentHostWhenIdle } from "../../src/host/force-stop.ts";
import type { HostLockRecord } from "../../src/host/lockfile.ts";
import { acquireHostStartupClaim } from "../../src/host/startup-claim.ts";
import { reconcileColdHost } from "../../src/release/cold-host-reconcile.ts";
import { defaultReadLiveHost } from "../../src/release/handoff.ts";
import { installRelease } from "../../src/release/install.ts";
import { defaultEnsureHost } from "../../src/release/upgrade.ts";
import { cloneRelease, createFixture, currentBuild, processAlive, readHostLock, stopHostProcess, waitUntil } from "../support/handoff-e2e.ts";

test("a host started between cold stop and activation is stopped after activation", async () => {
    const fixture = await createFixture();
    const oldHome = process.env.VERA_HOME;
    process.env.VERA_HOME = fixture.home;
    let restartedPid: number | undefined;
    let stops = 0;
    try {
        await defaultEnsureHost(fixture.build1Root, { operation: "install" });
        const nextBuild = "vera-cold-gap-next";
        const nextRoot = cloneRelease(fixture.build1Root, fixture.prefix, nextBuild);
        const manifest = JSON.parse(readFileSync(join(nextRoot, "manifest.json"), "utf8"));
        const result = await installRelease({
            prefix: fixture.prefix,
            pack: async () => ({ releaseRoot: nextRoot, manifest }),
            verify: () => {},
            report: () => {},
            hotHandOff: false,
            stopHost: async (options) => {
                stops += 1;
                const stopped = await stopResidentHostWhenIdle(options);
                if (stops === 1) {
                    expect(currentBuild(fixture.prefix)).toBe(fixture.build1);
                    await defaultEnsureHost(fixture.build1Root, { operation: "install" });
                    await waitUntil(() => readHostLock(fixture.home)?.build_id === fixture.build1, 10_000, "old host restarted");
                    restartedPid = readHostLock(fixture.home)!.pid;
                }
                return stopped;
            },
        });
        expect(result.kind).toBe("activated");
        expect(currentBuild(fixture.prefix)).toBe(nextBuild);
        expect(restartedPid).toBeDefined();
        expect(stops).toBe(2);
        expect(processAlive(restartedPid!)).toBe(false);
    } finally {
        await stopHostProcess(fixture.home).catch(() => {});
        fixture.cleanup();
        if (oldHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = oldHome;
    }
}, 120_000);

test("a host started after an empty host read is stopped after cold activation", async () => {
    const fixture = await createFixture();
    const oldHome = process.env.VERA_HOME;
    process.env.VERA_HOME = fixture.home;
    let restartedPid: number | undefined;
    let reads = 0;
    try {
        const nextBuild = "vera-cold-empty-next";
        const nextRoot = cloneRelease(fixture.build1Root, fixture.prefix, nextBuild);
        const manifest = JSON.parse(readFileSync(join(nextRoot, "manifest.json"), "utf8"));
        const result = await installRelease({
            prefix: fixture.prefix,
            pack: async () => ({ releaseRoot: nextRoot, manifest }),
            verify: () => {},
            report: () => {},
            readLiveHost: async () => {
                reads += 1;
                if (reads !== 1) return defaultReadLiveHost();
                await defaultEnsureHost(fixture.build1Root, { operation: "install" });
                restartedPid = readHostLock(fixture.home)!.pid;
                return undefined;
            },
        });
        expect(result.kind).toBe("activated");
        expect(currentBuild(fixture.prefix)).toBe(nextBuild);
        expect(restartedPid).toBeDefined();
        expect(processAlive(restartedPid!)).toBe(false);
    } finally {
        await stopHostProcess(fixture.home).catch(() => {});
        fixture.cleanup();
        if (oldHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = oldHome;
    }
}, 120_000);

test("reconciliation waits for the boot lock and leaves a matching host alone", async () => {
    const root = mkdtempSync("/tmp/vera-reconcile-");
    const home = join(root, "h");
    const prefix = join(root, "p");
    const share = join(prefix, "share", "vera");
    const oldHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    mkdirSync(share, { recursive: true });
    symlinkSync("releases/vera-current", join(share, "current"));
    const claim = await acquireHostStartupClaim({ path: join(home, "boot.lock"), maxClaimAgeMs: 15 * 60_000 });
    let reads = 0;
    let stops = 0;
    try {
        const pending = reconcileColdHost(prefix, async () => {
            reads += 1;
            return { pid: 123, build_id: "vera-current" } as HostLockRecord;
        }, async () => {
            stops += 1;
            return undefined;
        });
        await Bun.sleep(300);
        expect(reads).toBe(0);
        await claim.release();
        await pending;
        expect(reads).toBe(1);
        expect(stops).toBe(0);
    } finally {
        await claim.release();
        if (oldHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = oldHome;
        rmSync(root, { recursive: true, force: true });
    }
}, 15_000);
