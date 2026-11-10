import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { inProcessWorkerSocket } from "../../src/host/pool/in-process.ts";
import { inspectWorkerRecords } from "../../src/host/pool/worker-record.ts";
import { processCommandLine, processStartedAt } from "../../src/host/process-identity.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { socketTest } from "../support/socket-probe.ts";

interface PoolInfo {
    readonly pid: number;
    readonly workers: readonly number[];
    readonly annexPid?: number;
    readonly socket: string;
}

async function recordWithoutHostPid(): Promise<{ home: string; path: string; record: string }> {
    const home = await mkdtemp("/private/tmp/vera-dev/poolmod-record-");
    const runtime = join(home, "runtime");
    const directory = join(runtime, "workers");
    const path = join(directory, "w0.json");
    const record = JSON.stringify({
        id: "w0", index: 0, pid: process.pid,
        started_at: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
        socket_path: inProcessWorkerSocket(home, 0), control_path: join(runtime, "control.sock"),
        build_id: "record-build", owner: 123, count: 1,
    });
    await mkdir(directory, { recursive: true });
    await writeFile(path, record);
    return { home, path, record };
}

test("session process records require a host pid", async () => {
    const { home, path, record } = await recordWithoutHostPid();
    try {
        await expect(inspectWorkerRecords(home, "record-build")).rejects.toThrow("Invalid session process record");
        expect(await readFile(path, "utf8")).toBe(record);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

socketTest("startup rejects a session process record without a host pid", async () => {
    const { home, path, record } = await recordWithoutHostPid();
    let unexpected: ResidentHost | undefined;
    try {
        await expect(startResidentHost({
            home, buildId: "record-build", processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:9/v1", credential: "none" } },
            },
        }).then((host) => { unexpected = host; return host; })).rejects.toThrow("Invalid session process record");
        expect(await readFile(path, "utf8")).toBe(record);
    } finally {
        await unexpected?.close();
        await rm(home, { recursive: true, force: true });
    }
});

socketTest("startup replaces a verified worker from another build and a dead record", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h8b-records-");
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    const config = {
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:9/v1", credential: "none" } },
    } as const;
    await writeFile(join(home, "config.json"), JSON.stringify(config));
    const fixture = fileURLToPath(new URL("./fixtures/pool-adoption-host.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, fixture, "2", "20000"], {
        cwd: home, env: { ...process.env, VERA_HOME: home, VERA_DEV_INSTANCE: "hsplit8b old-record-build" },
        stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const started = new Map<number, { startedAt: number; command: string }>();
    let info: PoolInfo | undefined;
    let host: ResidentHost | undefined;
    const remember = (pid: number): void => {
        const startedAt = processStartedAt(pid);
        const command = processCommandLine(pid);
        if (startedAt === undefined || command === undefined) throw new Error(`Could not inspect process ${pid}`);
        started.set(pid, { startedAt, command });
    };
    const signal = (pid: number): void => {
        const recorded = started.get(pid);
        const startedAt = processStartedAt(pid);
        if (recorded === undefined || startedAt === undefined || Math.abs(startedAt - recorded.startedAt) > 2_000
            || processCommandLine(pid) !== recorded.command) throw new Error(`Process ${pid} no longer matches`);
        try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    try {
        await waitFor(() => existsSync(join(home, "ready.json")) || child.exitCode !== null, "pool startup");
        if (!existsSync(join(home, "ready.json"))) throw new Error(`Pool host failed: ${await stderr}`);
        info = JSON.parse(await readFile(join(home, "ready.json"), "utf8")) as PoolInfo;
        for (const pid of [...info.workers, ...(info.annexPid === undefined ? [] : [info.annexPid])]) remember(pid);
        expect((await requestHostIdentity(inProcessWorkerSocket(home, 0)))?.build_id).toBe("old-record-build");
        child.kill("SIGKILL");
        await child.exited;
        signal(info.workers[1]!);
        await waitFor(() => !alive(info!.workers[1]!), "dead recorded worker exit");
        expect(existsSync(join(home, "runtime", "workers", "w1.json"))).toBe(true);
        host = await startResidentHost({ home, config, webRoot, skipStartupDiscovery: true });
        expect(alive(info.workers[0]!)).toBe(false);
        for (let index = 0; index < 2; index += 1) {
            const identity = await requestHostIdentity(inProcessWorkerSocket(home, index));
            expect(identity?.pid).toBeDefined();
            expect(identity?.pid).not.toBe(info.workers[index]);
            remember(identity!.pid);
            const record = JSON.parse(await readFile(join(home, "runtime", "workers", `w${index}.json`), "utf8"));
            expect(record.pid).toBe(identity?.pid);
        }
    } finally {
        const annexPid = host?.annexPid;
        await host?.close();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await child.exited;
        for (const pid of started.keys()) {
            if (alive(pid)) signal(pid);
            await waitFor(() => !alive(pid), `process ${pid} exit`);
        }
        if (annexPid !== undefined) await waitFor(() => !alive(annexPid), "replacement annex exit");
        await stderr;
        await rm(home, { recursive: true, force: true });
    }
}, 40_000);

socketTest("startup leaves an answering socket alone when it belongs to another process", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h8b-busy-");
    const runtime = join(home, "runtime");
    const workers = join(runtime, "workers");
    await mkdir(workers, { recursive: true });
    const socketPath = inProcessWorkerSocket(home, 0);
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
    let server: Server | undefined;
    try {
        const startedAt = processStartedAt(child.pid);
        expect(startedAt).toBeDefined();
        const recordedStart = new Date(startedAt!).toISOString();
        server = createServer((socket) => socket.once("data", () => socket.end(`${JSON.stringify({
            type: "host_identity", pid: process.pid, started_at: recordedStart, role: "worker", worker_id: "w0",
            worker_index: 0, worker_count: 1, worker_generation: 1, build_id: "unrelated-build",
        })}\n`)));
        await new Promise<void>((resolve, reject) => server!.once("error", reject).listen(socketPath, resolve));
        await writeFile(join(workers, "w0.json"), JSON.stringify({
            id: "w0", index: 0, pid: child.pid, started_at: recordedStart, socket_path: socketPath,
            control_path: join(runtime, "control.sock"), build_id: "unrelated-build", host_pid: child.pid, count: 1,
        }));
        const config = {
            schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
            providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:9/v1", credential: "none" } },
        } as const;
        await expect(startResidentHost({ home, config, skipStartupDiscovery: true })).rejects.toThrow("worker_socket_busy");
        expect(alive(child.pid)).toBe(true);
        expect(existsSync(socketPath)).toBe(true);
        expect((await requestHostIdentity(socketPath))?.pid).toBe(process.pid);
        expect(existsSync(join(workers, "w0.json"))).toBe(true);
    } finally {
        if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await child.exited;
        expect(alive(child.pid)).toBe(false);
        await rm(home, { recursive: true, force: true });
    }
}, 20_000);

socketTest("startup does not touch workers of an answering host whose lockfile disappeared", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h8b-live-host-");
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    const config = {
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:9/v1", credential: "none" } },
    } as const;
    let host: ResidentHost | undefined;
    let workerPid: number | undefined;
    try {
        host = await startResidentHost({ home, config, webRoot, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true });
        workerPid = (await requestHostIdentity(inProcessWorkerSocket(home)))?.pid;
        expect(workerPid).toBeDefined();
        await unlink(join(home, "runtime", "host.json"));
        await expect(startResidentHost({ home, config, webRoot, buildId: "another-build", skipStartupDiscovery: true })).rejects.toThrow();
        expect((await requestHostIdentity(inProcessWorkerSocket(home)))?.pid).toBe(workerPid);
        expect(alive(workerPid!)).toBe(true);
    } finally {
        const annexPid = host?.annexPid;
        await host?.close();
        if (workerPid !== undefined) await waitFor(() => !alive(workerPid!), "worker exit");
        if (annexPid !== undefined) await waitFor(() => !alive(annexPid), "annex exit");
        await rm(home, { recursive: true, force: true });
    }
}, 30_000);

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await Bun.sleep(10);
    }
}
