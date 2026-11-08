import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { HOST_CAPABILITY_STOP_WAIT } from "../../src/host/capabilities.ts";
import { stopResidentHostWhenIdle } from "../../src/host/force-stop.ts";
import { forceStopPool } from "../../src/host/master/force-stop-pool.ts";
import { stopWorkerProcess } from "../../src/host/master/stop-worker.ts";
import { readRecordedWorkers, type RecordedWorker } from "../../src/host/master/worker-records.ts";
import { processIsAlive } from "../../src/host/process-identity.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
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

async function startPool(mode: "plain" | "pool" = "pool") {
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
        cwd: process.cwd(), env: { ...process.env, VERA_HOME: home, VERA_DEV_INSTANCE: "hsplit9 dev", HS9_STOP_MODE: mode }, stdio: "ignore",
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
            home, socket, masterPid: child.pid, workers, exited,
            get requests() { return requests; },
            release: () => gate.resolve(),
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

test("a pool stop waits for a running turn and reaps every process before removing the lock", async () => {
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
        expect(processIsAlive(pool.masterPid)).toBe(true);
        expect(existsSync(join(pool.home, "runtime", "host.json"))).toBe(true);
        pool.release();
        expect((await stop)?.endedBy).toBe("stopped");
        expect(await pool.exited).toBe(0);
        expect([pool.masterPid, ...pool.workers].filter(processIsAlive)).toEqual([]);
        expect(existsSync(join(pool.home, "runtime", "host.json"))).toBe(false);
    } finally {
        client?.close();
        await pool.cleanup();
    }
}, 30_000);

test("a pooled attachment hears the host stop wait", async () => {
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

test("plain and pooled attachments receive the same stop notifications", async () => {
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

test("an idle pool stops every process within 2.5 seconds", async () => {
    const pool = await startPool();
    try {
        const started = performance.now();
        const result = await stopResidentHostWhenIdle({ home: pool.home, lockPath: join(pool.home, "runtime", "host.json") });
        expect(result?.endedBy).toBe("stopped");
        expect(performance.now() - started).toBeLessThan(2_500);
        expect(await pool.exited).toBe(0);
        expect([pool.masterPid, ...pool.workers].filter(processIsAlive)).toEqual([]);
        expect(existsSync(join(pool.home, "runtime", "host.json"))).toBe(false);
    } finally {
        await pool.cleanup();
    }
}, 30_000);
