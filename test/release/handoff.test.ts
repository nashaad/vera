import { expect, test } from "bun:test";

import type { HostLockRecord } from "../../src/host/lockfile.ts";
import type { StopWhenIdleOutcome } from "../../src/host/force-stop.ts";
import { handOffUpdate, prefixOfReleaseRoot } from "../../src/release/handoff.ts";

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

test("handOffUpdate reports restored when no lock appears before the timeout", async () => {
    const outcome = await handOffUpdate({
        buildId: "vera-new",
        insideSession: false,
        report: () => undefined,
        stopHost: stopping({ pid: 1, endedBy: "stopped" }),
        readLiveHost: async () => undefined,
        timeoutMs: 20,
    });
    expect(outcome).toMatchObject({ kind: "restored", buildId: "vera-new" });
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
