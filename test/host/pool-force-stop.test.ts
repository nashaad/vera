import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCli, runCliMain } from "../../clients/cli/main.ts";
import { forceStopHostProcess } from "../../src/host/force-stop.ts";
import { forceStopPool } from "../../src/host/master/force-stop-pool.ts";
import { processIsAlive } from "../../src/host/process-identity.ts";
import { acquireHostStartupClaim, HostStartupInProgressError } from "../../src/host/startup-claim.ts";

interface TestChild {
    readonly child: ChildProcess;
    readonly pid: number;
    readonly started_at: string;
    readonly exited: Promise<void>;
}

function startChild(marker: string, ignoreTerm: boolean): TestChild {
    const startedAt = new Date().toISOString();
    const script = `const fs = require("node:fs");
process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(`${marker}.term`)}, "term"); ${ignoreTerm ? "" : "process.exit(0);"} });
fs.writeFileSync(${JSON.stringify(marker)}, "ready");
setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    if (child.pid === undefined) throw new Error("Test child did not start");
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    return { child, pid: child.pid, started_at: startedAt, exited };
}

async function ready(paths: readonly string[]): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!paths.every(existsSync)) {
        if (Date.now() >= deadline) throw new Error("Test children did not become ready");
        await Bun.sleep(10);
    }
}

async function clean(children: readonly TestChild[]): Promise<void> {
    for (const child of children) {
        if (processIsAlive(child.pid)) {
            await forceStopHostProcess(child, { sigtermGraceMs: 100, sigkillGraceMs: 1_000 });
        }
        await child.exited;
    }
}

test("force stop kills the master then stops every verified worker", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs9-force-");
    const runtime = join(home, "runtime");
    const workers = join(runtime, "workers");
    await mkdir(workers, { recursive: true });
    const markers = ["master", "w0", "w1", "w2"].map((name) => join(home, name));
    const children = markers.map((marker, index) => startChild(marker, index === 2));
    try {
        await ready(markers);
        const master = children[0]!;
        await writeFile(join(runtime, "host.json"), JSON.stringify({
            schema_version: 3, pid: master.pid, started_at: master.started_at,
            socket_path: join(runtime, "host.sock"), build_id: "test", role: "host", worker_count: 3,
        }));
        for (let index = 0; index < 3; index += 1) {
            const worker = children[index + 1]!;
            await writeFile(join(workers, `w${index}.json`), JSON.stringify({
                id: `w${index}`, pid: worker.pid, started_at: worker.started_at,
            }));
        }
        const started = performance.now();
        const result = await forceStopPool(home);
        expect(performance.now() - started).toBeLessThan(2_500);
        expect(result?.masterPid).toBe(master.pid);
        expect([...result!.workerPids].sort()).toEqual(children.slice(1).map((child) => child.pid).sort());
        await Promise.all(children.map((child) => child.exited));
        expect(children.every((child) => !processIsAlive(child.pid))).toBe(true);
        expect(existsSync(`${markers[2]}.term`)).toBe(true);
        expect(existsSync(join(runtime, "host.json"))).toBe(false);
    } finally {
        await clean(children);
        await rm(home, { recursive: true, force: true });
    }
}, 15_000);

test("a reused worker pid is not signalled", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs9-reused-");
    const workers = join(home, "runtime", "workers");
    await mkdir(workers, { recursive: true });
    const marker = join(home, "unrelated");
    const child = startChild(marker, false);
    try {
        await ready([marker]);
        await writeFile(join(workers, "w0.json"), JSON.stringify({
            id: "w0", pid: child.pid, started_at: "2000-01-01T00:00:00.000Z",
        }));
        expect((await forceStopPool(home))?.workerPids).toEqual([]);
        expect(processIsAlive(child.pid)).toBe(true);
        expect(existsSync(`${marker}.term`)).toBe(false);
    } finally {
        await clean([child]);
        await rm(home, { recursive: true, force: true });
    }
}, 15_000);

test("force stop reaches verified workers during startup but leaves a reused pid alone", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs9-force-start-");
    const runtime = join(home, "runtime");
    const workers = join(runtime, "workers");
    await mkdir(workers, { recursive: true });
    const markers = [join(home, "worker"), join(home, "unrelated")];
    const children = markers.map((marker) => startChild(marker, false));
    const claim = await acquireHostStartupClaim({ path: join(runtime, "host.sock.starting") });
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    try {
        await ready(markers);
        await writeFile(join(workers, "w0.json"), JSON.stringify({
            id: "w0", pid: children[0]!.pid, started_at: children[0]!.started_at,
        }));
        await writeFile(join(workers, "w1.json"), JSON.stringify({
            id: "w1", pid: children[1]!.pid, started_at: "2000-01-01T00:00:00.000Z",
        }));
        let output = "";
        let error = "";
        const result = await runCli(["host", "stop", "--force"], {
            confirmHostStop: async () => true,
            stdout: { write: (text) => { output += text; } },
            stderr: { write: (text) => { error += text; } },
        });
        expect(result).toBe(1);
        expect(output).toBe(`Stopped session process PID ${children[0]!.pid}.\n`);
        expect(error).toBe(`Resident host startup is already in progress (PID ${process.pid})\n`);
        await children[0]!.exited;
        expect(processIsAlive(children[0]!.pid)).toBe(false);
        expect(existsSync(`${markers[0]}.term`)).toBe(true);
        expect(processIsAlive(children[1]!.pid)).toBe(true);
        expect(existsSync(`${markers[1]}.term`)).toBe(false);
    } finally {
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        await claim.release();
        await clean(children);
        await rm(home, { recursive: true, force: true });
    }
}, 15_000);

test("force stop reaches a verified pooled master when another startup holds the claim", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs9-force-lock-");
    const runtime = join(home, "runtime");
    await mkdir(join(runtime, "workers"), { recursive: true });
    const marker = join(home, "master");
    const master = startChild(marker, false);
    const claim = await acquireHostStartupClaim({ path: join(runtime, "host.sock.starting") });
    try {
        await ready([marker]);
        await writeFile(join(runtime, "host.json"), JSON.stringify({
            schema_version: 3, pid: master.pid, started_at: master.started_at,
            socket_path: join(runtime, "host.sock"), build_id: "test", role: "host", worker_count: 1,
        }));
        const result = await forceStopPool(home).then(() => undefined, (error: unknown) => error);
        expect(result).toBeInstanceOf(HostStartupInProgressError);
        await master.exited;
        expect(processIsAlive(master.pid)).toBe(false);
    } finally {
        await claim.release();
        await clean([master]);
        await rm(home, { recursive: true, force: true });
    }
}, 15_000);

test("force stop accepts a startup claim already held by its caller", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs9-force-owned-");
    const runtime = join(home, "runtime");
    await mkdir(join(runtime, "workers"), { recursive: true });
    const marker = join(home, "master");
    const master = startChild(marker, false);
    const claimPath = join(runtime, "host.sock.starting");
    const claim = await acquireHostStartupClaim({ path: claimPath });
    try {
        await ready([marker]);
        await writeFile(join(runtime, "host.json"), JSON.stringify({
            schema_version: 3, pid: master.pid, started_at: master.started_at,
            socket_path: join(runtime, "host.sock"), build_id: "test", role: "host", worker_count: 1,
        }));
        expect(await forceStopPool(home, { startupClaim: claim })).toEqual({ masterPid: master.pid, workerPids: [] });
        await master.exited;
        expect(processIsAlive(master.pid)).toBe(false);
        expect(existsSync(claimPath)).toBe(true);
    } finally {
        await claim.release();
        await clean([master]);
        await rm(home, { recursive: true, force: true });
    }
}, 15_000);

test("a stale plain host lock cannot hide a live recorded session process", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs9-stale-worker-");
    const runtime = join(home, "runtime");
    const workers = join(runtime, "workers");
    await mkdir(workers, { recursive: true });
    const marker = join(home, "worker");
    const worker = startChild(marker, false);
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    try {
        await ready([marker]);
        await writeFile(join(runtime, "host.json"), JSON.stringify({
            schema_version: 3, pid: 2_000_000_901, started_at: "2000-01-01T00:00:00.000Z",
            socket_path: join(runtime, "host.sock"), build_id: "old-build",
        }));
        await writeFile(join(workers, "w0.json"), JSON.stringify({
            id: "w0", pid: worker.pid, started_at: worker.started_at,
        }));
        let output = "";
        let error = "";
        const code = await runCliMain(["host", "stop"], {
            confirmHostStop: async () => true,
            stdout: { write: (text) => { output += text; } },
            stderr: { write: (text) => { error += text; } },
        });
        expect(code).toBe(1);
        expect(output).toBe("");
        expect(error).toContain(`Session process PID ${worker.pid} is still running.`);
        expect(processIsAlive(worker.pid)).toBe(true);
    } finally {
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        await clean([worker]);
        await rm(home, { recursive: true, force: true });
    }
}, 15_000);
