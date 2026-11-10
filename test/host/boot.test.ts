import { expect, test } from "bun:test";

import { BootFailedError, bootResidentHost, renderBootBox, type BootCheck, type BootDependencies, type BootInspection, type HostMode } from "../../src/host/boot.ts";
import type { HostLockRecord } from "../../src/host/lockfile.ts";

const clean: BootInspection = { hostAnswers: false, lock: "absent", orphans: 0, unproven: 0, bootLoop: false };

function harness(inspection: BootInspection, starts: Array<(mode: HostMode) => HostLockRecord>, options: {
    published?: boolean;
    rollback?: string;
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
        confirm: async () => true,
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
