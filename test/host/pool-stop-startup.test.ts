import { expect, spyOn, test } from "bun:test";
import { socketAndLoopbackTest, socketTest } from "../support/socket-probe.ts";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCli } from "../../clients/cli/main.ts";
import { stopResidentHostWhenIdle } from "../../src/host/force-stop.ts";
import * as supervisor from "../../src/host/pool/supervisor.ts";
import { processIsAlive } from "../../src/host/process-identity.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { startHostServer } from "../../src/host/server.ts";
import { acquireHostStartupClaim } from "../../src/host/startup-claim.ts";
import { handOffUpdate } from "../../src/release/handoff.ts";

socketAndLoopbackTest("host stop does not report success while a pool is starting", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs9-start-stop-");
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    const stub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("not found", { status: 404 }) });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = supervisor.startSessionWorkerSupervisor;
    const probe = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation(async (options) => {
        entered.resolve();
        await release.promise;
        return await original(options);
    });
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    let host: ResidentHost | undefined;
    let workerPid: number | undefined;
    const starting = startResidentHost({
        home, webRoot, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
        config: {
            schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
            providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
        },
    });
    try {
        await entered.promise;
        const originalKill = process.kill.bind(process);
        const signals: Array<{ pid: number; signal: string | number | undefined }> = [];
        const kill = spyOn(process, "kill").mockImplementation((pid, signal) => {
            if (signal !== 0) { signals.push({ pid, signal }); return true; }
            return originalKill(pid, signal);
        });
        try {
            for (const flags of [[], ["--force"]]) {
                let output = "";
                let error = "";
                const code = await runCli(["host", "stop", ...flags], {
                    confirmHostStop: async () => true,
                    stdout: { write: (text) => { output += text; } },
                    stderr: { write: (text) => { error += text; } },
                });
                expect(code).toBe(1);
                expect(output).toBe("");
                expect(error).toBe(`Resident host startup is already in progress (PID ${process.pid})\n`);
            }
            expect(signals).toEqual([]);
        } finally {
            kill.mockRestore();
        }
        release.resolve();
        host = await starting;
        workerPid = (await requestHostIdentity(join(home, "runtime", "w0.sock")))?.pid;
        expect(workerPid).toBeDefined();
    } finally {
        release.resolve();
        host ??= await starting.catch(() => undefined);
        await host?.close();
        if (workerPid !== undefined) expect(processIsAlive(workerPid)).toBe(false);
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        probe.mockRestore();
        stub.stop(true);
        await rm(home, { recursive: true, force: true });
    }
}, 30_000);

test("an update handoff can stop its existing host while it holds the startup claim", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs9-owned-claim-");
    const runtime = join(home, "runtime");
    const lockPath = join(runtime, "host.json");
    await mkdir(runtime);
    await writeFile(lockPath, JSON.stringify({
        schema_version: 3, pid: process.pid, started_at: new Date().toISOString(),
        socket_path: join(runtime, "host.sock"), build_id: "old-build",
    }));
    const claim = await acquireHostStartupClaim({ path: join(runtime, "host.sock.starting") });
    try {
        const outcome = await handOffUpdate({
            buildId: "new-build", insideSession: true, report: () => {},
            stopHost: (options) => stopResidentHostWhenIdle({
                ...options, home, lockPath, startupClaim: claim, matchesRecord: () => true, isProcessAlive: () => true,
                requestStop: async () => ({ type: "accepted" }),
            }),
        });
        expect(outcome).toEqual({ kind: "accepted", buildId: "new-build" });
        await unlink(lockPath);
        const absent = await handOffUpdate({
            buildId: "new-build", insideSession: true, report: () => {},
            stopHost: (options) => stopResidentHostWhenIdle({ ...options, home, lockPath, startupClaim: claim }),
        });
        expect(absent.kind).toBe("not_moved");
    } finally {
        await claim.release();
        await rm(home, { recursive: true, force: true });
    }
});

socketTest("plain host stop refuses while startup holds the claim", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs9-plain-start-");
    const runtime = join(home, "runtime");
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const starting = startHostServer({
        socketPath: join(runtime, "host.sock"), lockPath: join(runtime, "host.json"),
        onListening: async () => { entered.resolve(); await release.promise; },
    });
    try {
        await entered.promise;
        const claimPath = join(runtime, "host.sock.starting");
        const claim = JSON.parse(await readFile(claimPath, "utf8"));
        await writeFile(claimPath, JSON.stringify({ ...claim, created_at: "2000-01-01T00:00:00.000Z" }));
        for (const flags of [[], ["--force"]]) {
            let error = "";
            let output = "";
            const code = await runCli(["host", "stop", ...flags], {
                confirmHostStop: async () => true,
                stdout: { write: (text) => { output += text; } },
                stderr: { write: (text) => { error += text; } },
            });
            expect(code).toBe(1);
            expect(output).toBe("");
            expect(error).toBe(`Resident host startup is already in progress (PID ${process.pid})\n`);
        }
        await writeFile(join(runtime, "host.json"), JSON.stringify({
            schema_version: 3, pid: 2_000_000_901, started_at: "2000-01-01T00:00:00.000Z",
            socket_path: join(runtime, "host.sock"), build_id: "old-build",
        }));
        for (const flags of [[], ["--force"]]) {
            let error = "";
            let output = "";
            const code = await runCli(["host", "stop", ...flags], {
                confirmHostStop: async () => true,
                stdout: { write: (text) => { output += text; } },
                stderr: { write: (text) => { error += text; } },
            });
            expect(code).toBe(1);
            expect(output).toBe("");
            expect(error).toBe(`Resident host startup is already in progress (PID ${process.pid})\n`);
        }
        await unlink(join(runtime, "host.json"));
    } finally {
        release.resolve();
        await (await starting).close();
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        await rm(home, { recursive: true, force: true });
    }
}, 30_000);

test("a pooled host with a custom socket refuses while its startup claim is held", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs9-custom-claim-");
    const runtime = join(home, "runtime");
    const socket = join(runtime, "custom.sock");
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    const claim = await acquireHostStartupClaim({ path: `${socket}.starting` });
    try {
        await writeFile(join(runtime, "host.json"), JSON.stringify({
            schema_version: 3, pid: process.pid, started_at: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
            socket_path: socket, build_id: "old-build", role: "host", worker_count: 1,
        }));
        let output = "";
        let error = "";
        const code = await runCli(["host", "stop"], {
            confirmHostStop: async () => true,
            stdout: { write: (text) => { output += text; } },
            stderr: { write: (text) => { error += text; } },
        });
        expect({ code, output, error }).toEqual({
            code: 1, output: "", error: `Resident host startup is already in progress (PID ${process.pid})\n`,
        });
    } finally {
        await claim.release();
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        await rm(home, { recursive: true, force: true });
    }
});

test("a dangling home alias and its target share the startup claim for both stops", async () => {
    const root = await mkdtemp("/private/tmp/vera-dev/hs9-claim-alias-");
    const previousHome = process.env.VERA_HOME;
    const alias = join(root, "alias");
    const target = join(root, "missing-home");
    await symlink(target, alias);
    const runStop = async (home: string, flags: readonly string[]): Promise<{ code: number; output: string; error: string }> => {
        process.env.VERA_HOME = home;
        let output = "";
        let error = "";
        const code = await runCli(["host", "stop", ...flags], {
            confirmHostStop: async () => true,
            stdout: { write: (text) => { output += text; } },
            stderr: { write: (text) => { error += text; } },
        });
        return { code, output, error };
    };
    try {
        expect(await runStop(alias, [])).toEqual({
            code: 0, output: "No resident Vera host is running.\n", error: "",
        });
        for (const [heldHome, stopHome] of [[target, alias], [alias, target]] as const) {
            const claim = await acquireHostStartupClaim({ path: join(heldHome, "runtime", "host.sock.starting") });
            try {
                for (const flags of [[], ["--force"]]) {
                    expect(await runStop(stopHome, flags)).toEqual({
                        code: 1, output: "", error: `Resident host startup is already in progress (PID ${process.pid})\n`,
                    });
                }
            } finally {
                await claim.release();
            }
        }
        await rm(target, { recursive: true, force: true });
        expect(await runStop(alias, ["--force"])).toEqual({
            code: 0, output: "No resident Vera host is recorded.\n", error: "",
        });
    } finally {
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        await rm(root, { recursive: true, force: true });
    }
});
