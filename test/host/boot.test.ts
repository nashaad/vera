import { expect, test } from "bun:test";

import { BootFailedError, bootResidentHost, renderBootBox, type BootCheck, type BootDependencies, type BootInspection, type BootQuestion, type HostMode } from "../../src/host/boot.ts";
import type { HostLockRecord } from "../../src/host/lockfile.ts";

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
    const deps: BootDependencies = {
        hostPublished: async () => options.published === true,
        inspect: async () => { calls.push("inspect"); return inspection; },
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

test("an orphaned host with no lock or socket is stopped before a fresh host starts", async () => {
    const { deps, calls, rendered } = harness({ ...clean, orphans: 10 }, [host(7)]);
    const started = await bootResidentHost(deps);
    expect(started.pid).toBe(7);
    expect(calls).toEqual(["inspect", "recover", "start:default"]);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.find((check) => check.label === "Leftover processes")?.status).toBe("failed");
    expect(rendered[0]!.find((check) => check.label === "Recovery")?.status).toBe("fixed");
});

test("a published host is used without the full check", async () => {
    const { deps, calls, rendered } = harness(clean, [host(3)], { published: true });
    expect((await bootResidentHost(deps)).pid).toBe(3);
    expect(calls).toEqual(["start:default"]);
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
