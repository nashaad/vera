import { afterEach, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

import type { HostLockRecord } from "../../src/host/lockfile.ts";
import { currentReleaseBuildId, releasesDirectory } from "../../src/release/layout.ts";
import {
    UpdateBusyError,
    waitForIdleHost,
    type BusySession,
    type IdleWaitOptions,
    type IdleWaitReport,
} from "../../src/release/update-wait.ts";
import { API, NEW_VERSION, withDesktopUpdate } from "./update-fixtures.ts";
import { finalLine, jsonRun } from "./update-json-support.ts";

// A host on another build, with a pid no test process descends from.
const HOST: HostLockRecord = {
    schema_version: 3,
    pid: 4_194_303,
    started_at: "2026-11-18T00:00:00.000Z",
    socket_path: "/nonexistent/host.sock",
    build_id: "vera-old",
};
const WORKING: BusySession[] = [{ id: "a1", title: "Fix the build" }, { id: "a2", title: "Write notes" }];

afterEach(() => {
    delete process.env.VERA_HOT_UPDATE;
});

// A clock the sleeps move, so a thirty minute wait takes no time.
function clock(): Pick<IdleWaitOptions, "now" | "sleep"> {
    let now = 1_000_000;
    return {
        now: () => now,
        sleep: async (ms) => { now += ms; },
    };
}

function idleOptions(extra: Partial<IdleWaitOptions>): IdleWaitOptions {
    return { readLiveHost: async () => HOST, pollMs: 1_000, ...clock(), ...extra };
}

test("@core an update waits while sessions work, names them, and goes on when they finish", async () => {
    let polls = 0;
    const reports: IdleWaitReport[] = [];
    await waitForIdleHost({
        buildId: "vera-new",
        onWaiting: (report) => reports.push(report),
        idle: idleOptions({ listBusy: async () => (++polls <= 3 ? WORKING : []), limitMs: 60_000 }),
    });
    expect(reports).toHaveLength(3);
    expect(reports[0]!.sessions).toEqual(WORKING);
    expect(reports.map((report) => report.waitedMs)).toEqual([0, 1_000, 2_000]);
    expect(reports[0]!.limitMs).toBe(60_000);
});

test("@core the wait ends at its limit and the error names the busy sessions", async () => {
    const reports: IdleWaitReport[] = [];
    const error = await waitForIdleHost({
        buildId: "vera-new",
        onWaiting: (report) => reports.push(report),
        idle: idleOptions({ listBusy: async () => WORKING, limitMs: 5_000 }),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UpdateBusyError);
    expect((error as UpdateBusyError).message).toBe(
        "Vera is still busy after 5 seconds: Fix the build, Write notes. Nothing was changed."
        + " Run the update again when the sessions have finished.",
    );
    expect(reports.at(-1)!.waitedMs).toBe(4_000);
});

test("cancelling ends the wait with the signal's reason", async () => {
    const controller = new AbortController();
    const error = await waitForIdleHost({
        buildId: "vera-new",
        signal: controller.signal,
        onWaiting: () => controller.abort(new Error("stopped")),
        idle: idleOptions({ listBusy: async () => WORKING, limitMs: 60_000 }),
    }).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("stopped");
});

test("an update that does not stop the host does not wait", async () => {
    const listed: string[] = [];
    const idle = (host: HostLockRecord | undefined): IdleWaitOptions => idleOptions({
        readLiveHost: async () => host,
        listBusy: async () => { listed.push("listed"); return WORKING; },
        limitMs: 5_000,
    });
    const run = (host: HostLockRecord | undefined): Promise<void> =>
        waitForIdleHost({ buildId: "vera-new", onWaiting: () => undefined, idle: idle(host) });
    await run(undefined);
    await run({ ...HOST, build_id: "vera-new" });
    process.env.VERA_HOT_UPDATE = "1";
    await run(HOST);
    expect(listed).toEqual([]);
});

test("the wait leaves time at the end of the run for the switch", async () => {
    const clocked = clock();
    const startedAt = clocked.now!();
    const error = await waitForIdleHost({
        buildId: "vera-new",
        deadlineAt: startedAt + 10 * 60_000,
        onWaiting: () => undefined,
        idle: idleOptions({ ...clocked, listBusy: async () => WORKING, limitMs: 30 * 60_000, pollMs: 60_000 }),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UpdateBusyError);
    expect((error as UpdateBusyError).limitMs).toBe(7 * 60_000);
});

test("a host that cannot list its sessions is not waited on", async () => {
    await waitForIdleHost({
        buildId: "vera-new",
        onWaiting: () => { throw new Error("waited"); },
        idle: idleOptions({ listBusy: async () => { throw new Error("socket closed"); } }),
    });
});

test("@core a busy host at the limit holds the update with the sessions named and nothing switched", async () => {
    await withDesktopUpdate(async (setup) => {
        const run = await jsonRun(setup, setup.feed(), {
            idle: idleOptions({ listBusy: async () => WORKING, limitMs: 3_000 }),
        });
        const phases = run.lines.map((line) => line.phase ?? line.result);
        expect(phases[0]).toBe("checking");
        expect(phases).toContain("waiting");
        expect(phases).not.toContain("switching");
        const waiting = run.lines.find((line) => line.phase === "waiting")!;
        expect(waiting).toEqual({
            phase: "waiting",
            sessions: WORKING,
            waited_ms: 0,
            limit_ms: 3_000,
        });
        expect(finalLine(run)).toMatchObject({ result: "held", version: NEW_VERSION, build: "vera-new", changed: false });
        expect(String(finalLine(run).message)).toContain("Fix the build, Write notes");
        expect(run.exit).toBe(0);
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-old");

        // The release is already unpacked, so the next run only waits and switches.
        expect(readdirSync(releasesDirectory(setup.prefix)).sort()).toEqual(["vera-new", "vera-old"]);
        const later = await jsonRun(setup, { [API]: setup.feed()[API]! }, {
            idle: idleOptions({ listBusy: async () => [], limitMs: 3_000 }),
        });
        expect(finalLine(later)).toMatchObject({ result: "done", changed: true });
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-new");
    }, { recorded: false });
});

test("@core cancelling while the update waits ends it cancelled with nothing switched", async () => {
    await withDesktopUpdate(async (setup) => {
        const controller = new AbortController();
        const run = await jsonRun(setup, setup.feed(), {
            signal: controller.signal,
            idle: idleOptions({ listBusy: async () => WORKING, limitMs: 60_000 }),
            onPhase: (phase) => {
                if (phase.phase === "waiting") controller.abort();
            },
        });
        expect(finalLine(run)).toEqual({ result: "cancelled", changed: false });
        expect(run.exit).toBe(1);
        expect(run.lines.some((line) => line.phase === "switching")).toBe(false);
        expect(currentReleaseBuildId(setup.prefix)).toBe("vera-old");
    }, { recorded: false });
});

test("sessions that finish during the wait let the update switch", async () => {
    await withDesktopUpdate(async (setup) => {
        let polls = 0;
        const run = await jsonRun(setup, setup.feed(), {
            idle: idleOptions({ listBusy: async () => (++polls <= 2 ? WORKING : []), limitMs: 60_000 }),
        });
        const phases = run.lines.map((line) => line.phase ?? line.result);
        expect(phases.filter((phase) => phase === "waiting")).toHaveLength(2);
        expect(phases.slice(-2)).toEqual(["switching", "done"]);
        expect(finalLine(run)).toMatchObject({ result: "done", changed: true });
    }, { recorded: false });
});
