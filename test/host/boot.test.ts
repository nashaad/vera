import { expect, test } from "bun:test";

import { BootFailedError, bootResidentHost, renderBootBox, type BootCheck, type BootDependencies, type BootInspection, type BootQuestion, type HostMode } from "../../src/host/boot.ts";
import { HostReplacementBusyError, HostStartDeadlineError } from "../../src/host/discovery.ts";
import { HostBuildMismatchError, HostLockUnreadableError, HostProtocolMismatchError, HostUnresponsiveError, type HostLockRecord } from "../../src/host/lockfile.ts";

const clean: BootInspection = { home: "/h/.vera", hostAnswers: false, lock: "absent", orphans: 0, unproven: 0, bootLoop: false };

function harness(inspection: BootInspection, starts: Array<(mode: HostMode) => HostLockRecord>, options: {
    published?: boolean;
    rollback?: string;
    answers?: Partial<Record<BootQuestion["id"], boolean>>;
    stash?: boolean;
} = {}) {
    const calls: string[] = [];
    const rendered: BootCheck[][] = [];
    let attempt = 0;
    let elapsed = 0;
    const deps: BootDependencies = {
        hostPublished: async () => options.published === true,
        hostAnswer: async () => inspection.hostAnswers ? { pid: 51, started_at: "2026-11-17T00:00:00.000Z" } : undefined,
        inspect: async () => { calls.push("inspect"); return inspection; },
        now: () => elapsed,
        wait: async (delayMs) => { elapsed += delayMs; },
        recover: async () => { calls.push("recover"); return { ok: true, lines: ["Stopped host PID 29252."] }; },
        start: async (mode) => {
            calls.push(`start:${mode}`);
            const next = starts[attempt++];
            if (next === undefined) throw new Error("Resident host did not start before its deadline");
            return next(mode);
        },
        rollback: async () => { calls.push("rollback"); return options.rollback; },
        clearBootFailures: () => {},
        confirm: async (question) => { calls.push(`ask:${question.id}`); return options.answers?.[question.id] ?? true; },
        ...(options.stash === true ? {
            stash: async () => { calls.push("stash"); return { path: "/h/.vera/runtime-stashes/stash-1", notCarried: [] }; },
            restoreStash: async () => { calls.push("restore"); },
            stopHost: async (record: HostLockRecord) => { calls.push(`stop:${record.pid}`); },
        } : {}),
        render: (checks) => { rendered.push([...checks]); },
    };
    return { deps, calls, rendered };
}

const host = (pid: number) => () => ({ pid, build_id: "vera-new" } as HostLockRecord);
const fail = () => { throw new Error("Resident host did not start before its deadline"); };

test("@core an answering host is attached when its missing lock reappears", async () => {
    const { deps, calls, rendered } = harness({ ...clean, hostAnswers: true }, [host(51)]);
    let elapsed = 0;
    const started = await bootResidentHost({
        ...deps,
        hostPublished: async () => elapsed >= 1_000,
        now: () => elapsed,
        wait: async (delayMs) => { elapsed += delayMs; },
    });
    expect(started.pid).toBe(51);
    expect(elapsed).toBe(1_000);
    expect(calls).toEqual(["inspect", "start:default"]);
    expect(rendered).toEqual([]);
});

test("@core a missing lock with an answering host is not recovered without consent", async () => {
    const { deps, calls, rendered } = harness({ ...clean, hostAnswers: true }, [], {
        answers: { stop_answering_host: false },
    });
    const questions: BootQuestion[] = [];
    const boot = bootResidentHost({
        ...deps,
        confirm: async (question) => { questions.push(question); calls.push(`ask:${question.id}`); return false; },
    });
    await expect(boot).rejects.toBeInstanceOf(BootFailedError);
    await expect(boot).rejects.toThrow("vera host reset");
    expect(questions).toEqual([{
        id: "stop_answering_host",
        text: "Vera host PID 51 is running but its lock file is missing. Stop it and start a fresh one?",
    }]);
    expect(calls).toEqual(["inspect", "ask:stop_answering_host"]);
    expect(rendered[0]).toContainEqual({ label: "Host lock", status: "failed", detail: "missing while host PID 51 answers" });
});

test("@core a start blocker is reported immediately when an answering host has no lock", async () => {
    const error = new Error("Invalid configuration");
    const { deps, calls, rendered } = harness({
        ...clean,
        hostAnswers: true,
        startBlocker: { label: "Configuration", error },
    }, []);
    await expect(bootResidentHost({
        ...deps,
        full: true,
        hostPublished: async () => { calls.push("probe published"); return false; },
        wait: async () => { calls.push("wait"); },
    })).rejects.toBe(error);
    expect(calls).toEqual(["inspect"]);
    expect(rendered[0]).toContainEqual({ label: "Configuration", status: "failed", detail: "Invalid configuration" });
    expect(rendered[0]).toContainEqual({ label: "Host lock", status: "failed", detail: "missing while a host answers" });
});

test("an answering host with a missing lock is recovered when the user agrees", async () => {
    const { deps, calls } = harness({ ...clean, hostAnswers: true }, [host(52)]);
    let answering = true;
    const started = await bootResidentHost({
        ...deps,
        hostAnswer: async () => answering ? { pid: 51, started_at: "2026-11-17T00:00:00.000Z" } : undefined,
        recover: async () => { calls.push("recover"); answering = false; return { ok: true, lines: [] }; },
    });
    expect(started.pid).toBe(52);
    expect(calls).toEqual(["inspect", "ask:stop_answering_host", "recover", "start:default"]);
});

test("@core a host still starting when the first wait ends is attached instead of being stopped", async () => {
    const startedAt = new Date().toISOString();
    let published = false;
    let inspects = 0;
    const { deps, calls, rendered } = harness(clean, [
        () => { published = true; throw new HostStartDeadlineError(); },
        host(51),
    ]);
    const started = await bootResidentHost({
        ...deps,
        hostPublished: async () => published,
        hostAnswer: async () => published ? { pid: 51, started_at: startedAt } : undefined,
        inspect: async () => {
            calls.push("inspect");
            inspects += 1;
            return inspects === 1
                ? clean
                : { ...clean, lock: "live" as const, hostAnswers: false, hostStartedAt: startedAt };
        },
    });
    expect(started.pid).toBe(51);
    expect(calls).toEqual(["inspect", "start:default", "inspect", "start:default"]);
    expect(calls).not.toContain("ask:stop_answering_host");
    expect(rendered).toEqual([]);
});

test("@core a host that finished starting before the next look is attached", async () => {
    const startedAt = new Date().toISOString();
    let published = false;
    let inspects = 0;
    const { deps, calls } = harness(clean, [
        () => { published = true; throw new HostStartDeadlineError(); },
        host(51),
    ]);
    const started = await bootResidentHost({
        ...deps,
        hostPublished: async () => published,
        hostAnswer: async () => ({ pid: 51, started_at: startedAt }),
        inspect: async () => {
            calls.push("inspect");
            inspects += 1;
            return inspects === 1
                ? clean
                : { ...clean, lock: "live" as const, hostAnswers: true, hostStartedAt: startedAt };
        },
    });
    expect(started.pid).toBe(51);
    expect(calls).toEqual(["inspect", "start:default", "inspect", "start:default"]);
    expect(calls).not.toContain("ask:stop_answering_host");
});

test("@core a live host older than the cold-start window is still confirmed before recovery", async () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    let inspects = 0;
    const { deps, calls } = harness(clean, [() => { throw new HostStartDeadlineError(); }], {
        answers: { stop_answering_host: false },
    });
    await expect(bootResidentHost({
        ...deps,
        hostAnswer: async () => ({ pid: 51, started_at: startedAt }),
        inspect: async () => {
            calls.push("inspect");
            inspects += 1;
            return inspects === 1
                ? clean
                : { ...clean, lock: "live" as const, hostAnswers: false, hostStartedAt: startedAt };
        },
    })).rejects.toThrow("vera host reset");
    expect(calls).toContain("ask:stop_answering_host");
    expect(calls).not.toContain("recover");
});

test("@core a host that starts answering after inspection is not recovered after a start failure", async () => {
    const { deps, calls } = harness(clean, [fail], { answers: { stop_answering_host: false } });
    let started = false;
    await expect(bootResidentHost({
        ...deps,
        hostAnswer: async () => started ? { pid: 51, started_at: "2026-11-17T00:00:00.000Z" } : undefined,
        start: async () => { calls.push("start:default"); started = true; return fail(); },
    })).rejects.toThrow("vera host reset");
    expect(calls).toEqual(["inspect", "start:default", "ask:stop_answering_host"]);
});

test("@core repair checks an answering host again before recovering a stale or damaged lock", async () => {
    for (const inspection of [
        { ...clean, hostAnswers: true, lock: "stale" as const },
        { ...clean, hostAnswers: true, lock: "damaged" as const },
        { ...clean, hostAnswers: true, lock: "stale" as const, bootLoop: true },
    ]) {
        const { deps, calls } = harness(inspection, [], { answers: { stop_answering_host: false } });
        await expect(bootResidentHost(deps)).rejects.toThrow("vera host reset");
        expect(calls).toEqual(["inspect", "ask:stop_answering_host"]);
    }
});

test("a stale lock without an answering host is recovered", async () => {
    const { deps, calls } = harness({ ...clean, lock: "stale" }, [host(52)]);
    expect((await bootResidentHost(deps)).pid).toBe(52);
    expect(calls).toEqual(["inspect", "recover", "start:default"]);
});

test("the existing live-lock restart question retains its behavior", async () => {
    const { deps, calls } = harness({ ...clean, hostAnswers: true, lock: "live" }, [fail, host(52)]);
    expect((await bootResidentHost(deps)).pid).toBe(52);
    expect(calls).toEqual(["inspect", "start:default", "ask:restart_running_host", "recover", "start:default"]);
});

test("consent to restart one host does not authorize recovery of a replacement", async () => {
    const { deps, calls } = harness({ ...clean, hostAnswers: true, lock: "live" }, [fail]);
    let probes = 0;
    await expect(bootResidentHost({
        ...deps,
        hostAnswer: async () => ({ pid: ++probes === 1 ? 51 : 52, started_at: "2026-11-17T00:00:00.000Z" }),
        confirm: async (question) => { calls.push(`ask:${question.id}`); return question.id === "restart_running_host"; },
    })).rejects.toThrow("vera host reset");
    expect(calls).toEqual(["inspect", "start:default", "ask:restart_running_host", "ask:stop_answering_host"]);
});

test("an orphaned host with no lock or socket is stopped before a fresh host starts", async () => {
    const { deps, calls, rendered } = harness({ ...clean, orphans: 10 }, [host(7)]);
    const started = await bootResidentHost(deps);
    expect(started.pid).toBe(7);
    expect(calls).toEqual(["inspect", "recover", "start:default"]);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.find((check) => check.label === "Leftover processes")?.status).toBe("failed");
    expect(rendered[0]!.find((check) => check.label === "Recovery")?.status).toBe("fixed");
});

test("surviving session processes are adopted before reset under the boot lock", async () => {
    const { deps, calls } = harness({ ...clean, lock: "stale", orphans: 1 }, []);
    const started = await bootResidentHost({
        ...deps,
        adopt: async () => { calls.push("adopt"); return host(8)(); },
        exclusive: async (run) => { calls.push("lock"); return run(); },
    });
    expect(started.pid).toBe(8);
    expect(calls).toEqual(["lock", "inspect", "adopt"]);
});

test("failed adoption reports the reason and resets before starting a fresh pooled host", async () => {
    const { deps, calls, rendered } = harness({ ...clean, lock: "stale", orphans: 1 }, [host(9)]);
    const started = await bootResidentHost({
        ...deps,
        full: true,
        adopt: async () => { calls.push("adopt"); throw new Error("adoption failed"); },
    });
    expect(started.pid).toBe(9);
    expect(calls).toEqual(["inspect", "adopt", "recover", "start:default"]);
    expect(rendered[0]).toContainEqual({ label: "Session processes", status: "warn", detail: "adoption failed" });
});

test("an ineligible session process is reset before starting a fresh host", async () => {
    const { deps, calls } = harness({ ...clean, lock: "stale", orphans: 1 }, [host(9)]);
    const started = await bootResidentHost({
        ...deps,
        adopt: async () => { calls.push("inspect workers"); return undefined; },
    });
    expect(started.pid).toBe(9);
    expect(calls).toEqual(["inspect", "inspect workers", "recover", "start:default"]);
});

test("unproven processes alone are reported without reset", async () => {
    const { deps, calls } = harness({ ...clean, unproven: 1 }, [host(10)]);
    const started = await bootResidentHost(deps);
    expect(started.pid).toBe(10);
    expect(calls).toEqual(["inspect", "start:default"]);
});

test("a published host is used without the full check", async () => {
    const { deps, calls, rendered } = harness(clean, [host(3)], { published: true });
    expect((await bootResidentHost(deps)).pid).toBe(3);
    expect(calls).toEqual(["start:default"]);
    expect(rendered).toEqual([]);
});

test("a failed published host still checks and adopts surviving sessions", async () => {
    const { deps, calls } = harness({ ...clean, lock: "stale", orphans: 1 }, [fail], { published: true });
    const started = await bootResidentHost({
        ...deps,
        adopt: async () => { calls.push("adopt"); return host(8)(); },
    });
    expect(started.pid).toBe(8);
    expect(calls).toEqual(["start:default", "inspect", "adopt"]);
});

test("@core published-host boot propagates discovery refusals without inspection or recovery", async () => {
    const refusals = [
        new HostReplacementBusyError(),
        new HostBuildMismatchError("client", "host"),
        new HostLockUnreadableError("/h/.vera/runtime/host.json", 51),
        new HostProtocolMismatchError(51, 999),
        new HostUnresponsiveError(51),
    ];
    for (const refusal of refusals) {
        const { deps, calls, rendered } = harness(clean, [() => { throw refusal; }], { published: true });
        await expect(bootResidentHost(deps)).rejects.toBe(refusal);
        expect(calls).toEqual(["start:default"]);
        expect(rendered).toEqual([]);
    }
});

test("@core checked healthy boot propagates discovery refusals without confirming or recovering", async () => {
    const refusals = [
        new HostReplacementBusyError(),
        new HostBuildMismatchError("client", "host"),
        new HostLockUnreadableError("/h/.vera/runtime/host.json", 51),
        new HostProtocolMismatchError(51, 999),
        new HostUnresponsiveError(51),
    ];
    for (const refusal of refusals) {
        const { deps, calls, rendered } = harness(
            { ...clean, hostAnswers: true, lock: "live" },
            [() => { throw refusal; }],
        );
        await expect(bootResidentHost(deps)).rejects.toBe(refusal);
        expect(calls).toEqual(["inspect", "start:default"]);
        expect(rendered).toEqual([]);
    }
});

test("boot stops recovery when a later start refuses replacement", async () => {
    const busy = new HostReplacementBusyError();
    for (const [starts, expected] of [
        [[() => { throw busy; }], ["inspect", "start:default"]],
        [[fail, () => { throw busy; }], ["inspect", "start:default", "recover", "start:single"]],
        [[fail, fail, () => { throw busy; }], ["inspect", "start:default", "recover", "start:single", "recover", "rollback", "start:single"]],
    ] as Array<[Array<(mode: HostMode) => HostLockRecord>, string[]]>) {
        const { deps, calls, rendered } = harness(clean, starts, { rollback: "vera-old", stash: true });
        await expect(bootResidentHost(deps)).rejects.toBe(busy);
        expect(calls).toEqual(expected);
        expect(rendered).toEqual([]);
    }
});

test("a discovery refusal during adoption does not reset session processes", async () => {
    const busy = new HostReplacementBusyError();
    const { deps, calls, rendered } = harness({ ...clean, orphans: 1 }, []);
    await expect(bootResidentHost({
        ...deps,
        adopt: async () => { calls.push("adopt"); throw busy; },
    })).rejects.toBe(busy);
    expect(calls).toEqual(["inspect", "adopt"]);
    expect(rendered).toEqual([]);
});

test("a refusal during fresh-runtime start leaves the running runtime alone", async () => {
    const busy = new HostReplacementBusyError();
    const { deps, calls, rendered } = harness(clean, [fail, fail, () => { throw busy; }], { stash: true });
    await expect(bootResidentHost(deps)).rejects.toBe(busy);
    expect(calls).toEqual([
        "inspect", "start:default", "recover", "start:single", "recover",
        "rollback", "ask:stash_runtime", "stash", "start:default",
    ]);
    expect(rendered).toEqual([]);
});

test("a host that cannot start pooled starts as a single process", async () => {
    const { deps, calls } = harness(clean, [fail, host(5)]);
    expect((await bootResidentHost(deps)).pid).toBe(5);
    expect(calls).toEqual(["inspect", "start:default", "recover", "start:single"]);
});

test("the previous release starts when this release cannot", async () => {
    const { deps, calls } = harness(clean, [fail, fail, host(9)], { rollback: "vera-old" });
    expect((await bootResidentHost(deps)).pid).toBe(9);
    expect(calls.slice(-2)).toEqual(["rollback", "start:single"]);
});

test("an unusable release rolls back before the first start", async () => {
    const { deps, calls } = harness({ ...clean, releaseProblem: "missing host binary" }, [host(4)], { rollback: "vera-old" });
    await bootResidentHost(deps);
    expect(calls).toEqual(["inspect", "rollback", "start:default"]);
});

test("every path failing shows the checklist and reports it", async () => {
    const { deps, rendered } = harness({ ...clean, lock: "stale" }, [], { rollback: undefined });
    await expect(bootResidentHost(deps)).rejects.toBeInstanceOf(BootFailedError);
    expect(rendered).toHaveLength(1);
    expect(renderBootBox(rendered[0]!)).toContain("Vera could not start.");
});

test("recent boot deaths are reported and recovered instead of blocking the start", async () => {
    const { deps, calls, rendered } = harness({ ...clean, bootLoop: true }, [host(8)]);
    expect((await bootResidentHost(deps)).pid).toBe(8);
    expect(calls).toEqual(["inspect", "recover", "start:default"]);
    expect(rendered[0]!.find((check) => check.label === "Recent start failures")?.status).toBe("failed");
});

test("after every other step fails, a fresh runtime starts once the user agrees, and is kept", async () => {
    const { deps, calls } = harness({ ...clean, unproven: 1, unknownProcesses: ["PID 99: no proof"] }, [fail, fail, host(12)], { stash: true });
    expect((await bootResidentHost(deps)).pid).toBe(12);
    expect(calls).toContain("ask:stash_runtime");
    expect(calls.indexOf("stash")).toBeGreaterThan(calls.indexOf("ask:stash_runtime"));
    expect(calls.at(-1)).toBe("ask:keep_fresh_runtime");
    expect(calls).not.toContain("restore");
});

test("answering no after the fresh start stops that host and puts the stash back", async () => {
    const { deps, calls } = harness(clean, [fail, fail, host(12)], { stash: true, answers: { keep_fresh_runtime: false } });
    await expect(bootResidentHost(deps)).rejects.toBeInstanceOf(BootFailedError);
    expect(calls.slice(-3)).toEqual(["ask:keep_fresh_runtime", "stop:12", "restore"]);
});

test("declining the stash moves nothing", async () => {
    const { deps, calls } = harness(clean, [], { stash: true, answers: { stash_runtime: false } });
    await expect(bootResidentHost(deps)).rejects.toBeInstanceOf(BootFailedError);
    expect(calls).not.toContain("stash");
});

test("a fresh runtime that also fails to start is rolled back on its own", async () => {
    const { deps, calls } = harness(clean, [], { stash: true });
    await expect(bootResidentHost(deps)).rejects.toBeInstanceOf(BootFailedError);
    expect(calls.at(-1)).toBe("restore");
});

test("the check and repair run inside the boot lock, and a host published while waiting is used", async () => {
    const { deps, calls } = harness({ ...clean, orphans: 1 }, [host(21)]);
    let published = false;
    const locked: BootDependencies = {
        ...deps,
        hostPublished: async () => published,
        exclusive: async (run) => { calls.push("lock"); published = true; return run(); },
    };
    expect((await bootResidentHost(locked)).pid).toBe(21);
    expect(calls).toEqual(["lock", "start:default"]);
});

test("a home on a Windows drive fails its check", async () => {
    const { deps, rendered } = harness({ ...clean, homeProblem: "on a Windows drive" }, [host(2)]);
    await bootResidentHost({ ...deps, full: true });
    expect(rendered[0]![0]).toEqual({ label: "Vera home", status: "failed", detail: "on a Windows drive" });
});

test("a start blocker is reported as it is, without a repair, a restart or a stash offer", async () => {
    const blocker = new Error("Vera's home path is too long.\nOn macOS a Vera home path can be at most 85 characters, and this one is 120.");
    const { deps, calls, rendered } = harness(
        { ...clean, orphans: 2, startBlocker: { label: "Host socket path", error: blocker } },
        [host(1)],
        { stash: true },
    );
    await expect(bootResidentHost({ ...deps, full: true })).rejects.toBe(blocker);
    expect(calls).toEqual(["inspect"]);
    const failed = rendered[0]!.find((check) => check.label === "Host socket path");
    expect(failed).toEqual({
        label: "Host socket path",
        status: "failed",
        detail: "Vera's home path is too long.",
    });
});

test("a start blocker does not stop a host that already answers", async () => {
    const blocker = new Error("config is refused");
    const { deps, calls } = harness(
        { ...clean, hostAnswers: true, lock: "live", startBlocker: { label: "Config", error: blocker } },
        [host(6)],
    );
    expect((await bootResidentHost(deps)).pid).toBe(6);
    expect(calls).toEqual(["inspect", "start:default"]);
});

test("the stash offer names why the runtime folder could not start", async () => {
    const questions: string[] = [];
    const { deps } = harness(clean, [], { stash: true });
    await expect(bootResidentHost({
        ...deps,
        start: async () => { throw new Error("session worker 2 exited with code 3"); },
        confirm: async (question) => { questions.push(question.text); return false; },
    })).rejects.toBeInstanceOf(BootFailedError);
    expect(questions[0]).toContain("Vera could not start with its current runtime folder: session worker 2 exited with code 3");
});
