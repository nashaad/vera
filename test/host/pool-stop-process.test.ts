import { expect } from "bun:test";
import { socketTest } from "../support/socket-probe.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";

import { runCli } from "../../clients/cli/main.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { HOST_CAPABILITY_STOP_WAIT } from "../../src/host/capabilities.ts";
import { forceStopHostProcess, forceStopResidentHost, stopResidentHostWhenIdle } from "../../src/host/force-stop.ts";
import { forceStopPool } from "../../src/host/pool/force-stop-pool.ts";
import { stopWorkerProcess } from "../../src/host/pool/stop-worker.ts";
import { readRecordedWorkers, type RecordedWorker } from "../../src/host/pool/worker-records.ts";
import { processIsAlive } from "../../src/host/process-identity.ts";
import { requestHostIdentity, requestHostStop } from "../../src/host/protocol.ts";
import { TURNS_HELD_REFUSAL } from "../../src/host/stop-when-idle.ts";
import { readPoolWorkerPids } from "../support/pool-worker-pids.ts";

async function waitFor(check: () => boolean | Promise<boolean>, description: string): Promise<void> {
    const until = Date.now() + 15_000;
    while (!await check()) {
        if (Date.now() >= until) throw new Error(`Timed out waiting for ${description}`);
        await Bun.sleep(25);
    }
}

async function finishPool(child: ChildProcess, exited: Promise<number | null>, home: string, known: readonly RecordedWorker[]): Promise<void> {
    const records = [...known, ...await readRecordedWorkers(home)];
    try { await forceStopPool(home); } catch {}
    if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const stopped = await Promise.race([exited.then(() => true), Bun.sleep(2_500).then(() => false)]);
        if (!stopped) child.kill("SIGKILL");
    }
    await exited;
    records.push(...await readRecordedWorkers(home));
    for (const record of records) await stopWorkerProcess(record);
    expect(records.map((record) => record.pid).filter(processIsAlive)).toEqual([]);
}

async function startPool(mode: "plain" | "pool" = "pool", delayReplacement = false) {
    const home = await mkdtemp("/private/tmp/vera-dev/hs9-stop-");
    const web = join(home, "web");
    await mkdir(web);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(web, name), "")));
    const gate = Promise.withResolvers<void>();
    let requests = 0;
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            requests += 1;
            await gate.promise;
            return new Response('data: {"id":"stub","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
                headers: { "content-type": "text/event-stream" },
            });
        },
    });
    await writeFile(join(home, "config.json"), JSON.stringify({
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
    }));
    const child: ChildProcess = spawn(process.execPath, [join(import.meta.dir, "fixtures", "pool-stop-host.ts")], {
        cwd: process.cwd(), env: { ...process.env, VERA_HOME: home, VERA_DEV_INSTANCE: "stopfix dev", HS9_STOP_MODE: mode,
            ...(delayReplacement ? { HS9_DELAY_REPLACEMENT: "1" } : {}) }, stdio: "ignore",
    });
    const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
    const socket = join(home, "runtime", "host.sock");
    try {
        await waitFor(async () => {
            if (child.exitCode !== null || child.signalCode !== null) throw new Error("Pool host exited during startup");
            const identity = await requestHostIdentity(socket).catch(() => undefined);
            return identity !== undefined && (mode === "plain" || identity.workers_ready === 3)
                && existsSync(join(home, "runtime", "host.json"))
                && !existsSync(`${socket}.starting`);
        }, "pool readiness");
        const workers = mode === "pool" ? await readPoolWorkerPids(home) : [];
        if ((mode === "pool" && workers.length !== 3) || child.pid === undefined) throw new Error("Pool processes are unavailable");
        const records = await readRecordedWorkers(home);
        return {
            home, socket, hostPid: child.pid, workers, exited,
            get requests() { return requests; },
            release: () => gate.resolve(),
            releaseReplacement: async () => { await writeFile(join(home, "replacement-release"), ""); },
            async crash() {
                child.kill("SIGKILL");
                await exited;
            },
            async cleanup() {
                gate.resolve();
                try {
                    await finishPool(child, exited, home, records);
                    expect([child.pid!, ...workers].filter(processIsAlive)).toEqual([]);
                } finally {
                    stub.stop(true);
                    if ([child.pid!, ...workers].every((pid) => !processIsAlive(pid))) {
                        await rm(home, { recursive: true, force: true });
                    }
                }
            },
        };
    } catch (error) {
        gate.resolve();
        try { await finishPool(child, exited, home, []); }
        finally { stub.stop(true); }
        await rm(home, { recursive: true, force: true });
        throw error;
    }
}

for (const mode of ["plain", "pool"] as const) {
    for (const force of [false, true]) {
        socketTest(`${mode} fresh host ${force ? "forced" : "ordinary"} stop works without an attached TUI`, async () => {
            const fixture = await startPool(mode);
            try {
                const liveDirectory = join(fixture.home, "machine", "live");
                await waitFor(() => existsSync(join(liveDirectory, `${fixture.hostPid}.json`)), "host live record");
                const recordedPids = (await readdir(liveDirectory)).map((name) => Number(name.replace(/\.json$/, "")))
                    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
                const command = Bun.spawn([process.execPath, "clients/cli/main.ts", "host", "stop", ...(force ? ["--force"] : []), "--yes"], {
                    cwd: process.cwd(),
                    env: { ...process.env, VERA_HOME: fixture.home, VERA_DEV_INSTANCE: "stopfix dev" },
                    stdout: "pipe", stderr: "pipe",
                });
                const [exitCode, stdout, stderr] = await Promise.all([
                    command.exited, new Response(command.stdout).text(), new Response(command.stderr).text(),
                ]);
                expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
                expect(stdout).toContain("Stopped resident Vera host");
                expect(await fixture.exited).toBe(0);
                expect(existsSync(join(fixture.home, "runtime", "host.json"))).toBe(false);
                expect(existsSync(fixture.socket)).toBe(false);
                for (const pid of recordedPids) {
                    expect(processIsAlive(pid)).toBe(false);
                    expect(existsSync(join(liveDirectory, `${pid}.json`))).toBe(false);
                }
            } finally {
                await fixture.cleanup();
            }
        }, 30_000);
    }

    for (const force of [false, true]) {
        socketTest(`${mode} ${force ? "forced" : "ordinary"} stop clears a crashed host socket and live record`, async () => {
            const fixture = await startPool(mode);
            try {
                const livePath = join(fixture.home, "machine", "live", `${fixture.hostPid}.json`);
                await waitFor(() => existsSync(livePath), "host live record");
                await fixture.crash();
                expect(existsSync(fixture.socket)).toBe(true);
                if (mode === "pool" && !force) {
                    for (const worker of await readRecordedWorkers(fixture.home)) await stopWorkerProcess(worker);
                }
                const command = Bun.spawn([process.execPath, "clients/cli/main.ts", "host", "stop", ...(force ? ["--force"] : []), "--yes"], {
                    cwd: process.cwd(),
                    env: { ...process.env, VERA_HOME: fixture.home, VERA_DEV_INSTANCE: "stopfix dev" },
                    stdout: "pipe", stderr: "pipe",
                });
                const [exitCode, stdout, stderr] = await Promise.all([
                    command.exited, new Response(command.stdout).text(), new Response(command.stderr).text(),
                ]);
                expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
                expect(stdout.length).toBeGreaterThan(0);
                expect(existsSync(join(fixture.home, "runtime", "host.json"))).toBe(false);
                expect(existsSync(fixture.socket)).toBe(false);
                expect(existsSync(livePath)).toBe(false);
                expect(fixture.workers.filter(processIsAlive)).toEqual([]);
            } finally {
                await fixture.cleanup();
            }
        }, 30_000);
    }

    for (const force of [false, true]) {
        socketTest(`${mode} ${force ? "forced" : "ordinary"} idle stop removes owned process records and notifies attachments`, async () => {
            const fixture = await startPool(mode);
            let client: AttachedAgentClient | undefined;
            try {
                const session = await createAgentThroughHost(fixture.socket, fixture.home);
                client = await attachAgent({
                    socketPath: fixture.socket,
                    agentId: session.id,
                    requestedCapabilities: [HOST_CAPABILITY_STOP_WAIT],
                });
                const events: string[] = [];
                client.onStopWait((event) => events.push(event.type === "host_stop_wait_cleared"
                    ? `${event.type}:${event.reason}` : event.type));
                await client.receive(AbortSignal.timeout(10_000));
                await client.send({ type: "prompt", content: "Chart a short course." });
                await waitFor(() => fixture.requests === 1, "model request");
                fixture.release();
                while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
                const liveDirectory = join(fixture.home, "machine", "live");
                await waitFor(() => existsSync(join(liveDirectory, `${fixture.hostPid}.json`)), "host live record");
                const liveNames = await readdir(liveDirectory);
                const recordedPids = liveNames.map((name) => Number(name.replace(/\.json$/, "")))
                    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
                expect(recordedPids).toContain(fixture.hostPid);

                const command = Bun.spawn([process.execPath, "clients/cli/main.ts", "host", "stop", ...(force ? ["--force"] : []), "--yes"], {
                    cwd: process.cwd(),
                    env: { ...process.env, VERA_HOME: fixture.home, VERA_DEV_INSTANCE: "stopfix dev" },
                    stdout: "pipe",
                    stderr: "pipe",
                });
                const [exitCode, stdout, stderr] = await Promise.all([
                    command.exited,
                    new Response(command.stdout).text(),
                    new Response(command.stderr).text(),
                ]);
                expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
                expect(stdout).toContain("Stopped resident Vera host");
                expect(events).toContain("host_stop_wait_cleared:stopped");
                expect(await fixture.exited).toBe(0);
                expect(fixture.workers.filter(processIsAlive)).toEqual([]);
                expect(existsSync(join(fixture.home, "runtime", "host.json"))).toBe(false);
                expect(existsSync(fixture.socket)).toBe(false);
                for (const pid of recordedPids) {
                    expect(processIsAlive(pid)).toBe(false);
                    expect(existsSync(join(liveDirectory, `${pid}.json`))).toBe(false);
                }
            } finally {
                client?.close();
                await fixture.cleanup();
            }
        }, 30_000);
    }

    socketTest(`${mode} forced stop tells an attachment before cutting a running turn`, async () => {
        const fixture = await startPool(mode);
        let client: AttachedAgentClient | undefined;
        try {
            const session = await createAgentThroughHost(fixture.socket, fixture.home);
            client = await attachAgent({
                socketPath: fixture.socket,
                agentId: session.id,
                requestedCapabilities: [HOST_CAPABILITY_STOP_WAIT],
            });
            const events: string[] = [];
            client.onStopWait((event) => events.push(event.type === "host_stop_wait_cleared"
                ? `${event.type}:${event.reason}` : event.type));
            await client.receive(AbortSignal.timeout(10_000));
            await client.send({ type: "prompt", content: "Keep sailing." });
            await waitFor(() => fixture.requests === 1, "running turn");
            const command = Bun.spawn([process.execPath, "clients/cli/main.ts", "host", "stop", "--force", "--yes"], {
                cwd: process.cwd(),
                env: { ...process.env, VERA_HOME: fixture.home, VERA_DEV_INSTANCE: "stopfix dev" },
                stdout: "pipe", stderr: "pipe",
            });
            const [exitCode, stdout, stderr] = await Promise.all([
                command.exited, new Response(command.stdout).text(), new Response(command.stderr).text(),
            ]);
            expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
            expect(stdout).toContain("Stopped resident Vera host");
            expect(events).toContain("host_stop_wait_cleared:stopped");
            expect(await fixture.exited).toBe(0);
            expect(existsSync(fixture.socket)).toBe(false);
            expect(existsSync(join(fixture.home, "runtime", "host.json"))).toBe(false);
            expect(fixture.workers.filter(processIsAlive)).toEqual([]);
        } finally {
            fixture.release();
            client?.close();
            await fixture.cleanup();
        }
    }, 30_000);

    socketTest(`${mode} signal fallback removes the stopped host's socket and live record`, async () => {
        const fixture = await startPool(mode);
        try {
            const livePath = join(fixture.home, "machine", "live", `${fixture.hostPid}.json`);
            await waitFor(() => existsSync(livePath), "host live record");
            expect(existsSync(fixture.socket)).toBe(true);
            if (mode === "pool") {
                const result = await forceStopPool(fixture.home);
                expect(result?.hostPid).toBe(fixture.hostPid);
            } else {
                const result = await forceStopResidentHost({
                    home: fixture.home, lockPath: join(fixture.home, "runtime", "host.json"),
                    firstSignal: "SIGKILL", sigkillGraceMs: 2_000,
                });
                expect(result?.endedBy).toBe("sigkill");
            }
            await fixture.exited;
            expect(existsSync(fixture.socket)).toBe(false);
            expect(existsSync(join(fixture.home, "runtime", "host.json"))).toBe(false);
            expect(existsSync(livePath)).toBe(false);
            expect(fixture.workers.filter(processIsAlive)).toEqual([]);
        } finally {
            await fixture.cleanup();
        }
    }, 30_000);
}

socketTest("a pool stop waits for a running turn and reaps every process before removing the lock", async () => {
    const pool = await startPool();
    let client: AttachedAgentClient | undefined;
    try {
        const session = await createAgentThroughHost(pool.socket, pool.home);
        client = await attachAgent({ socketPath: pool.socket, agentId: session.id });
        await client.receive(AbortSignal.timeout(10_000));
        await client.send({ type: "prompt", content: "Keep working." });
        await waitFor(() => pool.requests === 1, "running turn");
        const waiting = Promise.withResolvers<void>();
        let finished = false;
        const stop = stopResidentHostWhenIdle({
            home: pool.home, lockPath: join(pool.home, "runtime", "host.json"),
            onWaiting: () => waiting.resolve(),
        }).finally(() => { finished = true; });
        await waiting.promise;
        await Bun.sleep(300);
        expect(finished).toBe(false);
        expect(processIsAlive(pool.hostPid)).toBe(true);
        expect(existsSync(join(pool.home, "runtime", "host.json"))).toBe(true);
        pool.release();
        expect((await stop)?.endedBy).toBe("stopped");
        expect(await pool.exited).toBe(0);
        expect([pool.hostPid, ...pool.workers].filter(processIsAlive)).toEqual([]);
        expect(existsSync(join(pool.home, "runtime", "host.json"))).toBe(false);
    } finally {
        client?.close();
        await pool.cleanup();
    }
}, 30_000);

socketTest("a stop replies immediately and waits for a delayed replacement and running turn", async () => {
    const pool = await startPool("pool", true);
    let client: AttachedAgentClient | undefined;
    let stop: Promise<number> | undefined;
    try {
        const lost = await createAgentThroughHost(pool.socket, pool.home);
        const running = await createAgentThroughHost(pool.socket, pool.home);
        expect(lost.location!.worker_id).not.toBe(running.location!.worker_id);
        client = await attachAgent({ socketPath: running.location!.socket_path, agentId: running.id });
        await client.receive(AbortSignal.timeout(10_000));
        await client.send({ type: "prompt", content: "Keep working." });
        await waitFor(() => pool.requests === 1, "running turn");
        const old = await requestHostIdentity(lost.location!.socket_path);
        if (old === undefined) throw new Error("Session process identity is unavailable");
        await forceStopHostProcess(old, { firstSignal: "SIGKILL", sigkillGraceMs: 1_000 });
        await waitFor(() => existsSync(join(pool.home, "replacement-entered")), "replacement startup");
        const first = Promise.withResolvers<readonly unknown[]>();
        let output = "";
        let error = "";
        let finished = false;
        stop = runCli(["host", "stop"], {
            confirmHostStop: async () => true,
            stopHost: (options) => stopResidentHostWhenIdle({
                ...options, home: pool.home, lockPath: join(pool.home, "runtime", "host.json"),
                requestStop: (socket, identity, onWaiting, requestOptions) => requestHostStop(socket, identity, (waiting) => {
                    first.resolve(waiting);
                    onWaiting(waiting);
                }, requestOptions),
            }),
            stdout: { write: (text) => { output += text; } },
            stderr: { write: (text) => { error += text; } },
        }).finally(() => { finished = true; });
        expect(await Promise.race([first.promise, Bun.sleep(900).then(() => { throw new Error("No first stop reply"); })])).toEqual([]);
        await Bun.sleep(1_250);
        expect(finished).toBe(false);
        expect(processIsAlive(pool.hostPid)).toBe(true);
        expect(existsSync(join(pool.home, "runtime", "host.json"))).toBe(true);
        await pool.releaseReplacement();
        let replacement: RecordedWorker | undefined;
        await waitFor(async () => {
            replacement = (await readRecordedWorkers(pool.home)).find((record) => record.id === lost.location!.worker_id && record.pid !== old.pid);
            return replacement !== undefined;
        }, "replacement record");
        await waitFor(() => output.includes("Stopping after running turns end."), "running-turn notice");
        expect(await client.send({ type: "prompt", content: "Start another turn." }).then(() => "accepted", (reason: Error) => reason.message))
            .toBe(TURNS_HELD_REFUSAL);
        expect(finished).toBe(false);
        pool.release();
        expect(await stop).toBe(0);
        expect(error).toBe("");
        expect(output).toContain(`Stopped resident Vera host PID ${pool.hostPid} after its running turns ended.`);
        expect(await pool.exited).toBe(0);
        expect([pool.hostPid, ...pool.workers, replacement!.pid].filter(processIsAlive)).toEqual([]);
        expect(existsSync(join(pool.home, "runtime", "host.json"))).toBe(false);
    } finally {
        await pool.releaseReplacement().catch(() => {});
        pool.release();
        client?.close();
        await pool.cleanup();
        await stop?.catch(() => {});
    }
}, 35_000);

socketTest("a stop already waiting does not finish while a replacement is starting", async () => {
    const pool = await startPool("pool", true);
    let client: AttachedAgentClient | undefined;
    let stop: Promise<number> | undefined;
    try {
        const lost = await createAgentThroughHost(pool.socket, pool.home);
        const running = await createAgentThroughHost(pool.socket, pool.home);
        expect(lost.location!.worker_id).not.toBe(running.location!.worker_id);
        client = await attachAgent({
            socketPath: running.location!.socket_path, agentId: running.id,
            requestedCapabilities: [HOST_CAPABILITY_STOP_WAIT],
        });
        const events: string[] = [];
        client.onStopWait((event) => events.push(event.type));
        await client.receive(AbortSignal.timeout(10_000));
        await client.send({ type: "prompt", content: "Keep working." });
        await waitFor(() => pool.requests === 1, "running turn");
        let output = "";
        let finished = false;
        stop = runCli(["host", "stop"], {
            confirmHostStop: async () => true,
            stopHost: (options) => stopResidentHostWhenIdle({
                ...options, home: pool.home, lockPath: join(pool.home, "runtime", "host.json"),
            }),
            stdout: { write: (text) => { output += text; } },
            stderr: { write: () => {} },
        }).finally(() => { finished = true; });
        await waitFor(() => output.includes("Stopping after running turns end."), "running-turn notice");
        const old = await requestHostIdentity(lost.location!.socket_path);
        if (old === undefined) throw new Error("Session process identity is unavailable");
        await forceStopHostProcess(old, { firstSignal: "SIGKILL", sigkillGraceMs: 1_000 });
        await waitFor(() => existsSync(join(pool.home, "replacement-entered")), "replacement startup");
        pool.release();
        while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
        await Bun.sleep(600);
        expect(finished).toBe(false);
        expect(events).not.toContain("host_stop_wait_cleared");
        expect(processIsAlive(pool.hostPid)).toBe(true);
        await pool.releaseReplacement();
        await waitFor(() => existsSync(join(pool.home, "replacement-ready.json")), "replacement readiness");
        const replacement = JSON.parse(await readFile(join(pool.home, "replacement-ready.json"), "utf8")) as { pid: number };
        expect(await stop).toBe(0);
        expect(await pool.exited).toBe(0);
        expect([pool.hostPid, ...pool.workers, replacement.pid].filter(processIsAlive)).toEqual([]);
        expect(existsSync(join(pool.home, "runtime", "host.json"))).toBe(false);
    } finally {
        await pool.releaseReplacement().catch(() => {});
        pool.release();
        client?.close();
        await pool.cleanup();
        await stop?.catch(() => {});
    }
}, 35_000);

socketTest("a lost final stop reply has the same CLI result in plain and pool mode", async () => {
    for (const mode of ["plain", "pool"] as const) {
        const pool = await startPool(mode);
        const proxyPath = join(pool.home, "runtime", "stop-proxy.sock");
        const proxyLock = join(pool.home, "runtime", "proxy-host.json");
        const proxy = createServer((client) => {
            const upstream = createConnection(pool.socket);
            client.pipe(upstream);
            let buffered = "";
            upstream.setEncoding("utf8");
            upstream.on("data", (chunk: string) => {
                buffered += chunk;
                let newline = buffered.indexOf("\n");
                while (newline !== -1) {
                    const line = buffered.slice(0, newline);
                    buffered = buffered.slice(newline + 1);
                    if (JSON.parse(line).type === "stop_host_stopped") {
                        client.destroy();
                        upstream.destroy();
                        return;
                    }
                    client.write(`${line}\n`);
                    newline = buffered.indexOf("\n");
                }
            });
            upstream.on("error", () => client.destroy());
            client.on("error", () => upstream.destroy());
            client.on("close", () => upstream.destroy());
        });
        try {
            await new Promise<void>((resolve, reject) => proxy.listen(proxyPath, () => resolve()).once("error", reject));
            const record = JSON.parse(await readFile(join(pool.home, "runtime", "host.json"), "utf8")) as Record<string, unknown>;
            await writeFile(proxyLock, JSON.stringify({ ...record, socket_path: proxyPath }));
            let output = "";
            let error = "";
            const code = await runCli(["host", "stop"], {
                confirmHostStop: async () => true,
                stopHost: (options) => stopResidentHostWhenIdle({ ...options, home: pool.home, lockPath: proxyLock }),
                stdout: { write: (text) => { output += text; } },
                stderr: { write: (text) => { error += text; } },
            });
            expect({ code, output, error }).toEqual({
                code: 1,
                output: `Resident Vera host PID ${pool.hostPid} did not answer the stop request, so it was left running. Run 'vera host stop --force' to stop it now and cut its running turns.\n`,
                error: "",
            });
            expect(await pool.exited).toBe(0);
            expect([pool.hostPid, ...pool.workers].filter(processIsAlive)).toEqual([]);
        } finally {
            await new Promise<void>((resolve) => proxy.close(() => resolve()));
            await pool.cleanup();
        }
    }
}, 30_000);

socketTest("a pooled attachment hears the host stop wait", async () => {
    const pool = await startPool();
    let client: AttachedAgentClient | undefined;
    let stop: ReturnType<typeof stopResidentHostWhenIdle> | undefined;
    try {
        const session = await createAgentThroughHost(pool.socket, pool.home);
        client = await attachAgent({
            socketPath: pool.socket,
            agentId: session.id,
            requestedCapabilities: [HOST_CAPABILITY_STOP_WAIT],
        });
        expect(client.capabilities).toContain(HOST_CAPABILITY_STOP_WAIT);
        const events: string[] = [];
        client.onStopWait((event) => events.push(event.type));
        await client.receive(AbortSignal.timeout(10_000));
        await client.send({ type: "prompt", content: "Keep working." });
        await waitFor(() => pool.requests === 1, "running turn");
        const waiting = Promise.withResolvers<void>();
        stop = stopResidentHostWhenIdle({
            home: pool.home,
            lockPath: join(pool.home, "runtime", "host.json"),
            onWaiting: () => waiting.resolve(),
        });
        await waiting.promise;
        await Bun.sleep(1_000);
        expect(events).toContain("host_stop_wait");
    } finally {
        pool.release();
        if (stop !== undefined) await stop.catch(() => undefined);
        client?.close();
        await pool.cleanup();
    }
}, 30_000);

socketTest("plain and pooled attachments receive the same stop notifications", async () => {
    const outcomes: Array<readonly string[]> = [];
    for (const mode of ["plain", "pool"] as const) {
        const fixture = await startPool(mode);
        let client: AttachedAgentClient | undefined;
        let stop: ReturnType<typeof stopResidentHostWhenIdle> | undefined;
        try {
            const session = await createAgentThroughHost(fixture.socket, fixture.home);
            client = await attachAgent({
                socketPath: fixture.socket,
                agentId: session.id,
                requestedCapabilities: [HOST_CAPABILITY_STOP_WAIT],
            });
            const opened = Promise.withResolvers<void>();
            const cleared = Promise.withResolvers<void>();
            const events: string[] = [];
            client.onStopWait((event) => {
                if (event.type === "host_stop_wait") {
                    events.push(`${event.type}:${event.kind}`);
                    opened.resolve();
                } else if (event.type === "host_stop_wait_cleared") {
                    events.push(`${event.type}:${event.reason}`);
                    cleared.resolve();
                }
            });
            await client.receive(AbortSignal.timeout(10_000));
            await client.send({ type: "prompt", content: "Keep working." });
            await waitFor(() => fixture.requests === 1, "running turn");
            stop = stopResidentHostWhenIdle({ home: fixture.home, lockPath: join(fixture.home, "runtime", "host.json") });
            await Promise.race([opened.promise, Bun.sleep(5_000).then(() => { throw new Error("No stop wait event"); })]);
            fixture.release();
            await Promise.race([cleared.promise, Bun.sleep(5_000).then(() => { throw new Error("No stop cleared event"); })]);
            expect((await stop)?.endedBy).toBe("stopped");
            expect(await fixture.exited).toBe(0);
            outcomes.push(events);
        } finally {
            fixture.release();
            if (stop !== undefined) await stop.catch(() => undefined);
            client?.close();
            await fixture.cleanup();
        }
    }
    expect(outcomes).toEqual([
        ["host_stop_wait:stop", "host_stop_wait_cleared:stopped"],
        ["host_stop_wait:stop", "host_stop_wait_cleared:stopped"],
    ]);
}, 30_000);

socketTest("an idle pool stops every process within 2.5 seconds", async () => {
    const pool = await startPool();
    try {
        const started = performance.now();
        const result = await stopResidentHostWhenIdle({ home: pool.home, lockPath: join(pool.home, "runtime", "host.json") });
        expect(result?.endedBy).toBe("stopped");
        expect(performance.now() - started).toBeLessThan(2_500);
        expect(await pool.exited).toBe(0);
        expect([pool.hostPid, ...pool.workers].filter(processIsAlive)).toEqual([]);
        expect(existsSync(join(pool.home, "runtime", "host.json"))).toBe(false);
    } finally {
        await pool.cleanup();
    }
}, 30_000);
