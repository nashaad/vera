import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HostLockRecord } from "../../src/host/lockfile.ts";
import type { StopWhenIdleOutcome } from "../../src/host/force-stop.ts";
import { handOffUpdate, prefixOfReleaseRoot, runHandoff } from "../../src/release/handoff.ts";
import { runningInstallPrefix } from "../../src/release/layout.ts";

function liveRecord(pid: number, buildId: string): HostLockRecord {
    return { pid, build_id: buildId } as HostLockRecord;
}

function stopping(outcome: StopWhenIdleOutcome | undefined) {
    return async () => outcome;
}

test("prefixOfReleaseRoot reads the prefix only from an installed release path", () => {
    expect(prefixOfReleaseRoot("/opt/p/share/vera/releases/vera-a")).toBe("/opt/p");
    expect(prefixOfReleaseRoot("/opt/p/other/releases/vera-a")).toBeUndefined();
    expect(prefixOfReleaseRoot("/opt/p/share/vera/vera-a")).toBeUndefined();
});

test("running install prefix ignores checkouts and development instances", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-prefix-"));
    const previous = process.env.VERA_DEV_INSTANCE;
    try {
        delete process.env.VERA_DEV_INSTANCE;
        const root = join(prefix, "share", "vera", "releases", "vera-one");
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, "manifest.json"), "{}");
        expect(runningInstallPrefix(join(root, "vera-bin"))).toBe(prefix);
        expect(runningInstallPrefix(join(prefix, "checkout", "bun"))).toBeUndefined();
        process.env.VERA_DEV_INSTANCE = "test";
        expect(runningInstallPrefix(join(root, "vera-bin"))).toBeUndefined();
    } finally {
        if (previous === undefined) delete process.env.VERA_DEV_INSTANCE;
        else process.env.VERA_DEV_INSTANCE = previous;
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("handOffUpdate reports not_moved when no host runs", async () => {
    const outcome = await handOffUpdate({
        buildId: "vera-new",
        insideSession: false,
        report: () => undefined,
        stopHost: stopping(undefined),
    });
    expect(outcome.kind).toBe("not_moved");
});

test("handOffUpdate reports accepted when the host took the update from inside a session", async () => {
    const outcome = await handOffUpdate({
        buildId: "vera-new",
        insideSession: true,
        report: () => undefined,
        stopHost: stopping({ pid: 1, endedBy: "accepted" }),
    });
    expect(outcome).toEqual({ kind: "accepted", buildId: "vera-new" });
});

test("handOffUpdate reports updated once the target host publishes its lock", async () => {
    let reads = 0;
    const outcome = await handOffUpdate({
        buildId: "vera-new",
        insideSession: false,
        report: () => undefined,
        stopHost: stopping({ pid: 1, endedBy: "stopped" }),
        readLiveHost: async () => {
            reads += 1;
            return reads < 2 ? undefined : liveRecord(2, "vera-new");
        },
        timeoutMs: 5_000,
    });
    expect(outcome).toEqual({ kind: "updated", buildId: "vera-new" });
});

test("handOffUpdate reports restored when a different host is running after the stop", async () => {
    const outcome = await handOffUpdate({
        buildId: "vera-new",
        insideSession: false,
        report: () => undefined,
        stopHost: stopping({ pid: 1, endedBy: "stopped" }),
        readLiveHost: async () => liveRecord(2, "vera-old"),
        timeoutMs: 5_000,
    });
    expect(outcome.kind).toBe("restored");
});

test("handOffUpdate reports no_host_started when no lock appears before the timeout", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "handoff-unit-"));
    try {
        const shareRoot = join(prefix, "share", "vera");
        mkdirSync(shareRoot, { recursive: true });
        symlinkSync("releases/vera-new", join(shareRoot, "current"));
        const outcome = await handOffUpdate({
            buildId: "vera-new",
            insideSession: false,
            prefix,
            report: () => undefined,
            stopHost: stopping({ pid: 1, endedBy: "stopped" }),
            readLiveHost: async () => undefined,
            timeoutMs: 1_500,
        });
        expect(outcome).toEqual({
            kind: "no_host_started",
            buildId: "vera-new",
            currentBuildId: "vera-new",
            message: "No Vera host started within 2 seconds. current names vera-new. Run 'vera' to start it.",
        });
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("handOffUpdate leaves current where it is on refusal, abandon and silence", async () => {
    const cases: StopWhenIdleOutcome[] = [
        { pid: 1, endedBy: "refused", refusal: "stop_pending", message: "A stop is pending." },
        { pid: 1, endedBy: "abandoned", message: "The update was abandoned." },
        { pid: 1, endedBy: "no_answer" },
        { pid: 1, endedBy: "unsupported" },
    ];
    for (const stop of cases) {
        const outcome = await handOffUpdate({
            buildId: "vera-new",
            insideSession: false,
            report: () => undefined,
            stopHost: stopping(stop),
        });
        expect(outcome.kind).toBe("not_moved");
        if (outcome.kind === "not_moved") {
            expect(outcome.message).toContain("current was not moved");
        }
    }
});

test("handOffUpdate reports waiting targets from a terminal", async () => {
    const lines: string[] = [];
    await handOffUpdate({
        buildId: "vera-new",
        insideSession: false,
        report: (line) => lines.push(line),
        stopHost: async (options) => {
            options.onWaiting?.([{ session_id: "s1", name: "build", status: "working" }]);
            return { pid: 1, endedBy: "accepted" };
        },
    });
    expect(lines).toContain("Waiting on build (s1, working)");
});

test("handOffUpdate omits the repeated id when a waiting target has no name", async () => {
    const lines: string[] = [];
    await handOffUpdate({
        buildId: "vera-new",
        insideSession: false,
        report: (line) => lines.push(line),
        stopHost: async (options) => {
            options.onWaiting?.([{ session_id: "s2", name: null, status: "working" }]);
            return { pid: 1, endedBy: "accepted" };
        },
    });
    expect(lines).toContain("Waiting on s2 (working)");
});

const pending = { prefix: "/p", ownRoot: "/p/share/vera/releases/vera-old", ownBuildId: "vera-old", buildId: "vera-new" };

test("runHandoff restores this build when starting the target never finishes", async () => {
    const started: string[] = [];
    const activated: string[] = [];
    const reports: string[] = [];
    await runHandoff(pending, {
        ensureHost: (root) => {
            started.push(root);
            return root === pending.ownRoot ? Promise.resolve() : new Promise<void>(() => {});
        },
        activate: (root) => { activated.push(root); },
        report: (line) => reports.push(line),
        attemptTimeoutMs: 20,
    });
    expect(started).toEqual(["/p/share/vera/releases/vera-new", pending.ownRoot]);
    expect(activated).toEqual([pending.ownRoot]);
    expect(reports.at(-1)).toBe("Vera restored build vera-old and started its host.");
});

test("runHandoff returns when neither start finishes", async () => {
    const reports: string[] = [];
    await runHandoff(pending, {
        ensureHost: () => new Promise<void>(() => {}),
        activate: () => {},
        report: (line) => reports.push(line),
        attemptTimeoutMs: 20,
    });
    expect(reports).toHaveLength(2);
    expect(reports[1]).toStartWith("Vera could not restore build vera-old");
});
