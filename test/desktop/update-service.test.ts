import { expect, test } from "bun:test";

import { UPDATE_CHECK_INTERVAL_MS } from "../../clients/shared/updates.ts";
import { encodeUpdateProgress, type UpdateRunAnswer, type UpdateTask, type UpdateTaskReply } from "../../clients/desktop/src/update/task-protocol.ts";
import type { TaskListeners } from "../../clients/desktop/src/tasks/runner.ts";
import { HELD_WITHOUT_REASON, UpdateService, type UpdateTaskPort } from "../../clients/desktop/src/updates.ts";
import type { UpdateState } from "../../clients/ui/src/protocol/updates.ts";

type Handler = (task: UpdateTask, listeners: TaskListeners | undefined) => UpdateTaskReply | Promise<UpdateTaskReply>;

interface Port extends UpdateTaskPort {
    readonly tasks: UpdateTask[];
}

function port(handler: Handler): Port {
    const tasks: UpdateTask[] = [];
    return {
        tasks,
        run: async (task, listeners) => {
            tasks.push(task);
            return handler(task, listeners);
        },
    };
}

const COMMAND = "/prefix/bin/vera";

function checkReply(status: "up_to_date" | "available" | "downloaded" | "held" | "unavailable", extra: { latestVersion?: string; message?: string; mode?: "ask" | "automatic" | "off" } = {}): UpdateTaskReply {
    const { mode = "ask", ...rest } = extra;
    return { kind: "check", mode, intervalMs: UPDATE_CHECK_INTERVAL_MS, check: { status, currentVersion: "1.0.0", ...rest } };
}

function runReply(answer: UpdateRunAnswer): UpdateTaskReply {
    return { kind: "run", answer };
}

interface Rig {
    readonly service: UpdateService;
    readonly states: UpdateState[];
    readonly relaunches: number[];
    readonly timers: Array<{ readonly ms: number; readonly fire: () => void; cleared: boolean }>;
    readonly checks: Port;
    readonly modes: Port;
    readonly runs: Port;
    clock: { now: number };
}

function rig(parts: { checks?: Handler; modes?: Handler; runs?: Handler; command?: string | undefined } = {}): Rig {
    const checks = port(parts.checks ?? (() => checkReply("up_to_date")));
    const modes = port(parts.modes ?? ((task) => ({ kind: "mode", mode: task.kind === "mode" && task.mode !== undefined ? task.mode : "ask" })));
    const runs = port(parts.runs ?? (() => runReply({ result: "done", changed: true, version: "1.1.0" })));
    const states: UpdateState[] = [];
    const relaunches: number[] = [];
    const timers: Rig["timers"] = [];
    const clock = { now: 1_000_000 };
    const command = "command" in parts ? parts.command : COMMAND;
    const service = new UpdateService({
        home: "/home",
        command: () => command,
        checks,
        modes,
        runs,
        emit: (state) => states.push(state),
        relaunch: () => relaunches.push(clock.now),
        now: () => clock.now,
        timers: {
            set: (callback, ms) => {
                const entry = { ms, fire: callback, cleared: false };
                timers.push(entry);
                return entry;
            },
            clear: (handle) => {
                (handle as { cleared: boolean }).cleared = true;
            },
        },
    });
    return { service, states, relaunches, timers, checks, modes, runs, clock };
}

const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

test("@core starting checks once with the command and offers the release the check found", async () => {
    const { service, checks } = rig({ checks: () => checkReply("available", { latestVersion: "1.1.0" }) });
    service.start();
    service.start();
    await settle();
    expect(checks.tasks).toEqual([{ kind: "check", home: "/home", now: 1_000_000, force: true, command: COMMAND }]);
    expect(service.current()).toMatchObject({ capable: true, checking: false, currentVersion: "1.0.0", offer: { status: "available", latestVersion: "1.1.0" } });
});

test("@core the next check is scheduled from the interval the task reports, and asks for a due check only", async () => {
    const { service, checks, timers, clock } = rig({ checks: () => checkReply("up_to_date") });
    service.start();
    await settle();
    expect(timers.map((timer) => timer.ms)).toEqual([UPDATE_CHECK_INTERVAL_MS]);
    clock.now += UPDATE_CHECK_INTERVAL_MS;
    timers[0]?.fire();
    await settle();
    expect(checks.tasks[1]).toEqual({ kind: "check", home: "/home", now: clock.now, force: false, command: COMMAND, lastCheckedAt: 1_000_000 });
    expect(timers).toHaveLength(2);
});

test("@core a window with no update command checks nothing and is not capable", async () => {
    const { service, checks } = rig({ command: undefined, checks: () => ({ kind: "check", mode: "ask", intervalMs: UPDATE_CHECK_INTERVAL_MS }) });
    service.start();
    await settle();
    expect(checks.tasks[0]).toEqual({ kind: "check", home: "/home", now: 1_000_000, force: true });
    expect(service.current().capable).toBe(false);
    expect(service.current().offer).toBeUndefined();
    await service.update();
    expect(service.current().run).toEqual({ kind: "idle" });
});

test("@core mode off shows nothing, drops the offer and schedules no check", async () => {
    let mode: "ask" | "off" = "ask";
    const { service, timers } = rig({
        checks: () => (mode === "off" ? { kind: "check", mode: "off", intervalMs: UPDATE_CHECK_INTERVAL_MS } : checkReply("available", { latestVersion: "1.1.0" })),
        modes: (task) => ({ kind: "mode", mode: task.kind === "mode" && task.mode !== undefined ? task.mode : "ask" }),
    });
    service.start();
    await settle();
    expect(service.current().offer).toBeDefined();
    mode = "off";
    await service.setMode("off");
    expect(service.current().mode).toBe("off");
    expect([service.current().offer, service.current().held, service.current().problem]).toEqual([undefined, undefined, undefined]);
    expect(timers.every((timer) => timer.cleared)).toBe(true);
    await service.update();
    expect(service.current().run).toEqual({ kind: "idle" });
});

test("@core turning updates back on from off checks again at once", async () => {
    const { service, checks } = rig({ checks: () => checkReply("available", { latestVersion: "1.1.0" }) });
    await service.setMode("off");
    expect(checks.tasks).toEqual([]);
    await service.setMode("ask");
    expect(checks.tasks).toHaveLength(1);
    expect(checks.tasks[0]).toMatchObject({ kind: "check", force: true });
    expect(service.current().offer?.latestVersion).toBe("1.1.0");
});

test("a check that could not run keeps the offer the last check found and says why", async () => {
    let answer: UpdateTaskReply | Error = checkReply("available", { latestVersion: "1.1.0" });
    const { service } = rig({
        checks: () => {
            if (answer instanceof Error) throw answer;
            return answer;
        },
    });
    await service.check(true);
    answer = checkReply("unavailable", { message: "The release feed did not answer." });
    await service.check(true);
    expect(service.current()).toMatchObject({ offer: { status: "available" }, problem: "The release feed did not answer." });
    answer = new Error("The task did not answer in time.");
    await service.check(true);
    expect(service.current()).toMatchObject({ offer: { status: "available" }, problem: "The task did not answer in time." });
    answer = checkReply("up_to_date");
    await service.check(true);
    expect([service.current().offer, service.current().problem]).toEqual([undefined, undefined]);
});

test("a held check clears the offer and keeps the reason", async () => {
    const { service } = rig({ checks: () => checkReply("held", { message: "Vera.app cannot be replaced." }) });
    await service.check(true);
    expect(service.current().offer).toBeUndefined();
    expect(service.current().held).toBe("Vera.app cannot be replaced.");
});

test("@core automatic mode downloads in the background once, then offers the switch", async () => {
    let downloaded = false;
    const { service, runs, states } = rig({
        checks: () => checkReply(downloaded ? "downloaded" : "available", { latestVersion: "1.1.0", mode: "automatic" }),
        runs: () => {
            downloaded = true;
            return runReply({ result: "downloaded", changed: false, version: "1.1.0" });
        },
    });
    await service.check(true);
    await settle();
    expect(runs.tasks).toEqual([{ kind: "run", command: COMMAND, downloadOnly: true }]);
    expect(states.some((state) => state.background)).toBe(true);
    expect(service.current()).toMatchObject({ background: false, offer: { status: "downloaded", latestVersion: "1.1.0" } });
    await service.check(true);
    await settle();
    expect(runs.tasks).toHaveLength(1);
});

test("a background download that fails leaves the offer as it was", async () => {
    const { service } = rig({
        checks: () => checkReply("available", { latestVersion: "1.1.0", mode: "automatic" }),
        runs: () => runReply({ result: "failed", changed: false, message: "The download did not match its checksum." }),
    });
    await service.check(true);
    await settle();
    expect(service.current()).toMatchObject({ background: false, offer: { status: "available" }, run: { kind: "idle" } });
});

test("ask mode never downloads on its own", async () => {
    const { service, runs } = rig({ checks: () => checkReply("available", { latestVersion: "1.1.0" }) });
    await service.check(true);
    await settle();
    expect(runs.tasks).toEqual([]);
});

test("@core an update shows each phase, then relaunches the window once it is done", async () => {
    const seen: string[] = [];
    const { service, runs, relaunches, states, clock } = rig({
        checks: () => checkReply("available", { latestVersion: "1.1.0" }),
        runs: (_task, listeners) => {
            for (const progress of [
                { phase: "checking" },
                { phase: "downloading", bytes: 10, total: 100 },
                { phase: "waiting", sessions: [{ id: "crow", title: "Fix the build" }], waitedMs: 5000, limitMs: 600_000 },
                { phase: "switching" },
            ] as const) {
                clock.now += 300;
                listeners?.onProgress?.({ message: encodeUpdateProgress(progress), increment: undefined });
            }
            return runReply({ result: "done", changed: true, version: "1.1.0" });
        },
    });
    await service.check(true);
    await service.update();
    for (const state of states) if (seen.at(-1) !== state.run.kind) seen.push(state.run.kind);
    expect(seen).toEqual(["idle", "checking", "downloading", "waiting", "switching", "ended"]);
    expect(runs.tasks).toEqual([{ kind: "run", command: COMMAND, downloadOnly: false }]);
    expect(states.find((state) => state.run.kind === "waiting")?.run).toEqual({ kind: "waiting", sessions: [{ id: "crow", title: "Fix the build" }], waitedMs: 5000, limitMs: 600_000 });
    expect(service.current().offer).toBeUndefined();
    expect(service.current().run).toEqual({ kind: "ended", result: "done", version: "1.1.0" });
    expect(relaunches).toHaveLength(1);
});

test("@core an update that fails changes nothing, keeps the offer and can be run again", async () => {
    let attempt = 0;
    const { service, relaunches } = rig({
        checks: () => checkReply("available", { latestVersion: "1.1.0" }),
        runs: () => {
            attempt += 1;
            return attempt === 1 ? runReply({ result: "failed", changed: false, message: "The download stopped." }) : runReply({ result: "done", changed: true, version: "1.1.0" });
        },
    });
    await service.check(true);
    await service.update();
    expect(service.current()).toMatchObject({ offer: { status: "available" }, run: { kind: "ended", result: "failed", message: "The download stopped." } });
    expect(relaunches).toEqual([]);
    service.dismiss();
    expect(service.current().run).toEqual({ kind: "idle" });
    await service.update();
    expect(service.current().run).toMatchObject({ kind: "ended", result: "done" });
    expect(relaunches).toHaveLength(1);
});

test("a held update shows the reason, drops the offer and does not relaunch", async () => {
    const { service, relaunches } = rig({
        checks: () => checkReply("available", { latestVersion: "1.1.0" }),
        runs: () => runReply({ result: "held", changed: false, message: "Vera.app is in a folder Vera cannot write." }),
    });
    await service.check(true);
    await service.update();
    expect(service.current()).toMatchObject({ offer: undefined, held: "Vera.app is in a folder Vera cannot write.", run: { kind: "ended", result: "held", message: "Vera.app is in a folder Vera cannot write." } });
    expect(relaunches).toEqual([]);
});

test("a held update with no reason says nothing was changed", async () => {
    const { service } = rig({ runs: () => runReply({ result: "held", changed: false }) });
    await service.update();
    expect(service.current().run).toEqual({ kind: "ended", result: "held", message: HELD_WITHOUT_REASON });
});

test("an update that finds nothing newer says so", async () => {
    const { service } = rig({
        checks: () => checkReply("available", { latestVersion: "1.1.0" }),
        runs: () => runReply({ result: "up_to_date", changed: false }),
    });
    await service.check(true);
    await service.update();
    expect(service.current()).toMatchObject({ offer: undefined, run: { kind: "ended", result: "up_to_date" } });
});

test("@core cancelling while it waits stops the run, keeps the offer and relaunches nothing", async () => {
    const { service, relaunches } = rig({
        checks: () => checkReply("available", { latestVersion: "1.1.0" }),
        runs: (_task, listeners) => new Promise((resolve) => {
            listeners?.onProgress?.({ message: encodeUpdateProgress({ phase: "waiting", sessions: [{ id: "crow", title: "Fix the build" }], waitedMs: 1000, limitMs: 600_000 }), increment: undefined });
            listeners?.signal?.addEventListener("abort", () => resolve(runReply({ result: "cancelled", changed: false })), { once: true });
        }),
    });
    await service.check(true);
    const finished = service.update();
    await settle();
    expect(service.current().run.kind).toBe("waiting");
    service.cancel();
    await finished;
    expect(service.current()).toMatchObject({ offer: { status: "available" }, run: { kind: "ended", result: "cancelled" } });
    expect(relaunches).toEqual([]);
});

test("@core cancelling once the switch has begun does nothing", async () => {
    let aborted = false;
    let release: (reply: UpdateTaskReply) => void = () => undefined;
    const { service, relaunches } = rig({
        runs: (_task, listeners) => new Promise((resolve) => {
            release = resolve;
            listeners?.signal?.addEventListener("abort", () => {
                aborted = true;
            }, { once: true });
            listeners?.onProgress?.({ message: encodeUpdateProgress({ phase: "switching" }), increment: undefined });
        }),
    });
    const finished = service.update();
    await settle();
    expect(service.current().run.kind).toBe("switching");
    service.cancel();
    expect(aborted).toBe(false);
    release(runReply({ result: "done", changed: true, version: "1.1.0" }));
    await finished;
    expect(relaunches).toHaveLength(1);
});

test("@core a task that dies after the switch began still relaunches, and one that dies before does not", async () => {
    const after = rig({
        runs: (_task, listeners) => {
            listeners?.onProgress?.({ message: encodeUpdateProgress({ phase: "switching" }), increment: undefined });
            throw new Error("The task stopped without answering.");
        },
    });
    await after.service.update();
    expect(after.relaunches).toHaveLength(1);
    const before = rig({ runs: () => { throw new Error("The task stopped without answering."); } });
    await before.service.update();
    expect(before.relaunches).toEqual([]);
    expect(before.service.current().run).toEqual({ kind: "ended", result: "failed", message: "The task stopped without answering." });
});

test("a second update while one runs is ignored", async () => {
    let release: (reply: UpdateTaskReply) => void = () => undefined;
    const { service, runs } = rig({ runs: () => new Promise((resolve) => { release = resolve; }) });
    const first = service.update();
    await settle();
    await service.update();
    expect(runs.tasks).toHaveLength(1);
    release(runReply({ result: "up_to_date", changed: false }));
    await first;
});

test("a mode that was not saved says why and keeps the mode in the file", async () => {
    const { service } = rig({ modes: () => ({ kind: "mode", mode: "ask", problem: "config.json could not be read" }) });
    await service.setMode("off");
    expect(service.current()).toMatchObject({ mode: "ask", modeProblem: "config.json could not be read" });
});

test("progress lines are sent to the page at most four times a second", async () => {
    const { service, states, clock } = rig({
        runs: (_task, listeners) => {
            for (let bytes = 1; bytes <= 50; bytes += 1) {
                clock.now += 10;
                listeners?.onProgress?.({ message: encodeUpdateProgress({ phase: "downloading", bytes, total: 100 }), increment: undefined });
            }
            return runReply({ result: "up_to_date", changed: false });
        },
    });
    await service.update();
    expect(states.filter((state) => state.run.kind === "downloading").length).toBeLessThanOrEqual(3);
    expect(states.at(-1)?.run.kind).toBe("ended");
});

test("the newest progress goes out when the quiet time is up, so a stalled download shows where it stopped", async () => {
    let release: (reply: UpdateTaskReply) => void = () => undefined;
    const { service, states, timers, clock } = rig({
        runs: (_task, listeners) => new Promise((resolve) => {
            release = resolve;
            clock.now += 300;
            listeners?.onProgress?.({ message: encodeUpdateProgress({ phase: "downloading", bytes: 1, total: 10 }), increment: undefined });
            clock.now += 10;
            listeners?.onProgress?.({ message: encodeUpdateProgress({ phase: "downloading", bytes: 2, total: 10 }), increment: undefined });
        }),
    });
    const finished = service.update();
    await settle();
    expect(states.at(-1)?.run).toEqual({ kind: "downloading", bytes: 1, total: 10 });
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(240);
    clock.now += 240;
    timers[0]?.fire();
    expect(states.at(-1)?.run).toEqual({ kind: "downloading", bytes: 2, total: 10 });
    release(runReply({ result: "up_to_date", changed: false }));
    await finished;
});

test("stopping the service cancels a run, clears the timer and ends the sends", async () => {
    let aborted = false;
    const { service, timers, states } = rig({
        checks: () => checkReply("up_to_date"),
        runs: (_task, listeners) => new Promise((resolve) => {
            listeners?.signal?.addEventListener("abort", () => {
                aborted = true;
                resolve(runReply({ result: "cancelled", changed: false }));
            }, { once: true });
        }),
    });
    await service.check(true);
    const finished = service.update();
    await settle();
    service.stop();
    await finished;
    const sent = states.length;
    expect(aborted).toBe(true);
    expect(timers.every((timer) => timer.cleared)).toBe(true);
    await service.check(true);
    expect(states).toHaveLength(sent);
});
