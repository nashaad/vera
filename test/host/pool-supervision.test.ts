import { expect, spyOn } from "bun:test";
import { socketTest } from "../support/socket-probe.ts";
import { createServer, type Server } from "node:net";
import { mkdirSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";

import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { listAgentPageThroughHost } from "../../src/host/agent-list-client.ts";
import { forceStopHostProcess } from "../../src/host/force-stop.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { HOST_CAPABILITY_STOP_WAIT } from "../../src/host/capabilities.ts";
import { connectHost } from "../../src/host/connection.ts";
import { requestExtensionThroughHost } from "../../src/host/extension-request-client.ts";
import { HostInboxBridge } from "../../src/host/pool/inbox.ts";
import type { ControlPeer } from "../../src/host/pool/control.ts";
import * as supervisor from "../../src/host/pool/supervisor.ts";
import { requestHostIdentity, requestHostStop } from "../../src/host/protocol.ts";
import { startResidentHost, type ResidentHost, type StartResidentHostOptions } from "../../src/host/runtime.ts";
import { TURNS_HELD_REFUSAL } from "../../src/host/stop-when-idle.ts";
import { defaultInboxPath, Inbox } from "../../src/store/inbox.ts";
import { readSessionTurnState, WORKER_EXIT_TURN_MESSAGE } from "../../src/store/session-store.ts";
import type { WatchRuntimeContext } from "../../src/watch/source.ts";
import { startScheduleWakeProvider } from "../support/schedule-wake-provider.ts";

interface FixtureOptions {
    readonly workerCount?: number;
    readonly heartbeatMs?: number;
    readonly beforeStart?: (options: supervisor.SessionWorkerSupervisorOptions) => Promise<void>;
    readonly onConnected?: (peer: ControlPeer, options: supervisor.SessionWorkerSupervisorOptions) => void;
    readonly spawnSpec?: (options: supervisor.SessionWorkerSupervisorOptions) => supervisor.WorkerSpawnSpec | undefined;
    readonly provider?: { readonly port: number; readonly requests: number; close(): void };
    readonly prepare?: (home: string) => Promise<{ readonly extension?: string; readonly watch?: StartResidentHostOptions["watchConnectors"] }>;
}

function slowStopProvider() {
    const release = Promise.withResolvers<void>();
    let requests = 0;
    const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) {
                return new Response("not found", { status: 404 });
            }
            requests += 1;
            await release.promise;
            return new Response('data: {"id":"stub","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
                headers: { "content-type": "text/event-stream" },
            });
        },
    });
    return {
        port: server.port!, get requests() { return requests; },
        release: () => release.resolve(), close: () => server.stop(true),
    };
}

async function fixture(options: FixtureOptions = {}) {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "h8s-"));
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    const prepared = await options.prepare?.(home);
    const stub = options.provider ?? startScheduleWakeProvider(true);
    const pids = new Set<number>();
    const start = supervisor.startSessionWorkerSupervisor;
    const probe = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation(async (workerOptions) => {
        await options.beforeStart?.(workerOptions);
        const spawnSpec = options.spawnSpec?.(workerOptions);
        return await start({
            ...workerOptions,
            ...(spawnSpec === undefined ? {} : { spawnSpec }),
            onSpawn(pid) { pids.add(pid); workerOptions.onSpawn?.(pid); },
            onConnected(peer) {
                workerOptions.onConnected(peer);
                options.onConnected?.(peer, workerOptions);
            },
        });
    });
    let host: ResidentHost;
    try {
        host = await startResidentHost({
            home, webRoot, processWorker: true, processWorkerCount: options.workerCount ?? 2, skipStartupDiscovery: true,
            ...(options.heartbeatMs === undefined ? {} : { processWorkerHeartbeatDeadlineMs: options.heartbeatMs }),
            ...(prepared?.watch === undefined ? {} : { watchConnectors: prepared.watch }),
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
                inbox: { admit: ["arc"] },
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
                ...(prepared?.extension === undefined ? {} : { extensions: [{ path: prepared.extension, enabled: true, config: {} }] }),
            },
        });
    } catch (error) {
        probe.mockRestore();
        stub.close();
        await rm(home, { recursive: true, force: true });
        throw error;
    }
    if (host.annexPid !== undefined) pids.add(host.annexPid);
    return {
        home, host, pids, stub,
        async close() {
            try { await host.close(); }
            finally {
                stub.close();
                probe.mockRestore();
                try {
                    await waitFor(() => [...pids].every((pid) => !alive(pid)), "child processes to exit");
                    expect([...pids].filter(alive)).toEqual([]);
                } finally { await rm(home, { recursive: true, force: true }); }
            }
        },
    };
}

socketTest("session process losses and replacements are recorded in the host log", async () => {
    const harness = await fixture({
        async prepare(home) {
            await writeFile(join(home, "stderr-marker.ts"), 'console.error("x".repeat(17_000) + "worker stderr tail");\n');
            return {};
        },
        spawnSpec: (options) => ({
            command: process.execPath,
            args: ["--preload", join(options.home, "stderr-marker.ts"), join(process.cwd(), "clients/host/session-worker.ts")],
        }),
    });
    try {
        const socket = harness.host.server.socketPath;
        const lost = await createAgentThroughHost(socket, harness.home);
        const other = await createAgentThroughHost(socket, harness.home);
        expect(lost.location!.worker_id).not.toBe(other.location!.worker_id);
        const identity = await requestHostIdentity(lost.location!.socket_path);
        if (identity === undefined) throw new Error("Session process identity is unavailable");
        process.kill(identity.pid, "SIGKILL");
        const logPath = join(harness.home, "runtime", "logs", "host.jsonl");
        const events = async (): Promise<Array<Record<string, unknown>>> => {
            const text = await readFile(logPath, "utf8");
            return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
        };
        await waitFor(async () => (await events()).some((event) => event.type === "session_process_replaced"), "replacement log");
        const rows = await events();
        const losses = rows.filter((event) => event.type === "session_process_lost");
        expect(losses).toHaveLength(1);
        expect(losses[0]).toMatchObject({
            slot: lost.location!.worker_id, generation: 1, pid: identity.pid,
            exit_code: null, signal: "SIGKILL", sessions: [lost.id],
        });
        expect(["process_exited", "control_closed"]).toContain(losses[0]!.reason as string);
        expect(typeof losses[0]!.stderr_tail).toBe("string");
        expect((losses[0]!.stderr_tail as string).length).toBeLessThanOrEqual(16_384);
        expect(losses[0]!.stderr_tail).toEndWith("worker stderr tail\n");
        expect(rows.filter((event) => event.type === "session_process_replaced")).toEqual([
            expect.objectContaining({ slot: lost.location!.worker_id, generation: 2 }),
        ]);
        const replacement = rows.find((event) => event.type === "session_process_replaced");
        expect(replacement!.pid).not.toBe(identity.pid);
    } finally { await harness.close(); }
}, 30_000);

socketTest("vera ls keeps the last summaries while a session process is unavailable", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const harness = await fixture({
        workerCount: 3,
        beforeStart: async (options) => {
            if (options.generation === 2) { entered.resolve(); await release.promise; }
        },
    });
    try {
        const socket = harness.host.server.socketPath;
        const sessions = [];
        for (let index = 0; index < 3; index += 1) sessions.push(await createAgentThroughHost(socket, harness.home));
        await waitFor(async () => (await listAgentPageThroughHost(socket)).agents.length >= 3, "cached roster");
        const lost = sessions[0]!;
        const identity = await requestHostIdentity(lost.location!.socket_path);
        if (identity === undefined) throw new Error("Session process identity is unavailable");
        await forceStopHostProcess(identity, { firstSignal: "SIGKILL", sigkillGraceMs: 1_000 });
        await entered.promise;
        const page = await listAgentPageThroughHost(socket);
        const summary = page.agents.find((agent) => agent.id === lost.id);
        expect(summary).toBeDefined();
        expect(page.unavailableWorkers).toContain(lost.location!.worker_id);
        const command = Bun.spawn([
            "/usr/bin/env", `VERA_HOME=${harness.home}`, process.execPath, "clients/cli/main.ts", "ls", "--all",
        ], { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" });
        const [output, errors, code] = await Promise.all([
            new Response(command.stdout).text(), new Response(command.stderr).text(), command.exited,
        ]);
        expect(code, errors).toBe(0);
        expect(output).toContain(summary!.name ?? summary!.id);
        expect(output).toContain(`Unavailable session processes: ${lost.location!.worker_id}.`);
    } finally {
        release.resolve();
        await harness.close();
    }
}, 30_000);

socketTest("a pending pool stop holds new turns on every session process", async () => {
    const waiting = Promise.withResolvers<void>();
    const stub = slowStopProvider();
    const harness = await fixture({ workerCount: 3, provider: stub });
    const clients: AttachedAgentClient[] = [];
    let stop: ReturnType<typeof requestHostStop> | undefined;
    try {
        const socket = harness.host.server.socketPath;
        const first = await createAgentThroughHost(socket, harness.home);
        const second = await createAgentThroughHost(socket, harness.home);
        expect(first.location!.worker_id).not.toBe(second.location!.worker_id);
        for (const session of [first, second]) {
            const client = await attachAgent({ socketPath: socket, agentId: session.id,
                requestedCapabilities: [HOST_CAPABILITY_STOP_WAIT] });
            clients.push(client);
            await client.receive(AbortSignal.timeout(10_000));
        }
        await clients[0]!.send({ type: "prompt", content: "Keep working." });
        await waitFor(() => stub.requests === 1, "first turn");
        stop = requestHostStop(socket, harness.host.server.identity, () => waiting.resolve());
        await Promise.race([waiting.promise, Bun.sleep(10_000).then(() => { throw new Error("No stop wait"); })]);
        await waitFor(() => clients.every((client) => client.stopWait?.kind === "stop"), "stop notification on each session process");
        const result = await clients[1]!.send({ type: "prompt", content: "Start another turn." })
            .then(() => "accepted", (error: Error) => error.message);
        if (result === "accepted") await waitFor(() => stub.requests === 2, "second turn");
        expect({ result, requests: stub.requests }).toEqual({ result: TURNS_HELD_REFUSAL, requests: 1 });
    } finally {
        stub.release();
        for (const client of clients) client.close();
        await stop?.catch(() => {});
        await harness.close();
    }
}, 30_000);

socketTest("a replacement session process holds turns during a pending stop", async () => {
    const waiting = Promise.withResolvers<void>();
    const stub = slowStopProvider();
    const harness = await fixture({ workerCount: 3, provider: stub });
    const clients: AttachedAgentClient[] = [];
    let stop: ReturnType<typeof requestHostStop> | undefined;
    try {
        const socket = harness.host.server.socketPath;
        const first = await createAgentThroughHost(socket, harness.home);
        const replaced = await createAgentThroughHost(socket, harness.home);
        const running = await attachAgent({ socketPath: socket, agentId: first.id });
        clients.push(running);
        await running.receive(AbortSignal.timeout(10_000));
        await running.send({ type: "prompt", content: "Keep working." });
        await waitFor(() => stub.requests === 1, "first turn");
        stop = requestHostStop(socket, harness.host.server.identity, () => waiting.resolve());
        await Promise.race([waiting.promise, Bun.sleep(10_000).then(() => { throw new Error("No stop wait"); })]);
        const old = await requestHostIdentity(replaced.location!.socket_path);
        if (old === undefined) throw new Error("Session process identity is unavailable");
        await forceStopHostProcess(old, { firstSignal: "SIGKILL", sigkillGraceMs: 1_000 });
        const index = Number(replaced.location!.worker_id.slice(1));
        await waitFor(() => harness.host.health.workers?.[index]?.state === "replaced", "replacement");
        expect((await requestHostIdentity(replaced.location!.socket_path))?.pid).not.toBe(old.pid);
        await waitFor(async () => (await locate(socket, replaced.id)).type === "agent_location", "session location");
        const client = await attachAgent({ socketPath: replaced.location!.socket_path, agentId: replaced.id,
            requestedCapabilities: [HOST_CAPABILITY_STOP_WAIT] });
        clients.push(client);
        await client.receive(AbortSignal.timeout(10_000));
        await waitFor(() => client.stopWait?.kind === "stop", "replacement stop notification");
        const result = await client.send({ type: "prompt", content: "Start another turn." })
            .then(() => "accepted", (error: Error) => error.message);
        expect({ result, requests: stub.requests }).toEqual({ result: TURNS_HELD_REFUSAL, requests: 1 });
    } finally {
        stub.release();
        for (const client of clients) client.close();
        await stop?.catch(() => {});
        await harness.close();
    }
}, 30_000);

for (const kind of ["event", "request", "response"] as const) socketTest(`non-heartbeat ${kind} frames keep a session process alive until it goes silent`, async () => {
    let peer: ControlPeer | undefined;
    let activity = "";
    let stop = "";
    const harness = await fixture({
        workerCount: 1,
        heartbeatMs: 900,
        onConnected(connected, options) { if (options.generation === 1) peer = connected; },
        async prepare(home) {
            activity = join(home, "activity");
            stop = join(home, "stop-activity");
            const control = join(process.cwd(), "src/host/pool/control.ts");
            await writeFile(join(home, "delay-heartbeats.ts"), `import { appendFileSync, existsSync } from "node:fs";
import { ControlPeer } from ${JSON.stringify(control)};
const original = ControlPeer.prototype.event;
let started = false;
ControlPeer.prototype.event = function(event, value) {
    if (event !== "heartbeat") return original.call(this, event, value);
    if (!started) {
        started = true;
        const current = this;
        const timer = setInterval(() => {
            if (existsSync(${JSON.stringify(stop)})) { clearInterval(timer); return; }
            const sending = ${JSON.stringify(kind)} === "event"
                ? original.call(current, "test_liveness", { rss_bytes: 1, event_loop_lag_ms: 2 })
                : ${JSON.stringify(kind)} === "request" ? current.request("recovery.owns", ["crow"]) : undefined;
            if (sending !== undefined) void sending.then(() => appendFileSync(${JSON.stringify(activity)}, "sent\\n"), () => {});
        }, 100);
        timer.unref();
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => { void original.call(this, event, value).then(resolve, resolve); }, 10_000);
        timer.unref();
    });
};
`);
            return {};
        },
        spawnSpec: (options) => ({
            command: process.execPath,
            args: ["--preload", join(options.home, "delay-heartbeats.ts"), join(process.cwd(), "clients/host/session-worker.ts")],
        }),
    });
    try {
        const original = harness.host.health.workers?.[0]?.pid;
        expect(original).toBeDefined();
        expect(peer).toBeDefined();
        let replies = 0;
        const end = Date.now() + 2_500;
        while (Date.now() < end) {
            if (kind === "response") {
                await peer!.request("session.snapshot", [], AbortSignal.timeout(1_000));
                replies += 1;
            }
            await Bun.sleep(100);
        }
        if (kind === "response") expect(replies).toBeGreaterThan(5);
        else expect((await readFile(activity, "utf8")).trim().split("\n").length).toBeGreaterThan(5);
        expect(harness.host.health.workers?.[0]).toMatchObject({ generation: 1, state: "ready", pid: original });
        expect(harness.host.health.workers?.[0]?.rss_bytes).toBeUndefined();
        expect(harness.host.health.workers?.[0]?.event_loop_lag_ms).toBeUndefined();
        await writeFile(stop, "stop");
        await waitFor(() => harness.host.health.workers?.[0]?.state === "replaced", "silent worker replacement");
        expect(harness.host.health.workers?.[0]).toMatchObject({ reason: "heartbeat_timeout" });
        expect(alive(original!)).toBe(false);
    } finally {
        await harness.close();
    }
}, 30_000);

socketTest("a hard-looping worker misses its heartbeat while identity and locate remain responsive", async () => {
    let marker = "";
    const harness = await fixture({
        heartbeatMs: 900,
        async prepare(home) {
            const extension = join(home, "blocker");
            marker = join(home, "blocked");
            await mkdir(extension);
            await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
                id: "test.blocker", version: "1.0.0", sdk: "1", entrypoint: "extension.ts", capabilities: ["requests.handle"],
            }));
            await writeFile(join(extension, "extension.ts"), `import { writeFileSync } from "node:fs";
export function activate(vera) { vera.requests.handle("block", () => { writeFileSync(${JSON.stringify(marker)}, "blocked"); while (true) {} }); }
`);
            return { extension };
        },
    });
    let request: Promise<unknown> | undefined;
    try {
        const socket = harness.host.server.socketPath;
        await waitFor(() => harness.host.health.workers?.every((worker) =>
            typeof worker.rss_bytes === "number" && typeof worker.event_loop_lag_ms === "number") === true,
        "session process diagnostics");
        const first = await createAgentThroughHost(socket, harness.home);
        const second = await createAgentThroughHost(socket, harness.home);
        const oldPid = (await requestHostIdentity(first.location!.socket_path))!.pid;
        request = requestExtensionThroughHost(first.location!.socket_path, "test.blocker", "block", {}, AbortSignal.timeout(8_000)).catch(() => undefined);
        await waitFor(() => existsSync(marker), "worker hard loop");
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const started = performance.now();
            expect(await requestHostIdentity(socket)).toBeDefined();
            expect((await locate(socket, first.id)).type).toBeDefined();
            expect((await locate(socket, second.id)).type).toBe("agent_location");
            expect((await locate(socket, `unknown-crow-${attempt}`)).type).toBe("agent_location_failed");
            expect(performance.now() - started).toBeLessThan(1_000);
            await Bun.sleep(100);
        }
        const index = Number(first.location!.worker_id.slice(1));
        await waitFor(() => harness.host.health.workers?.[index]?.state === "replaced", "heartbeat replacement");
        expect(harness.host.health.workers?.[index]).toMatchObject({ reason: "heartbeat_timeout" });
        expect(alive(oldPid)).toBe(false);
        expect((await requestHostIdentity(first.location!.socket_path))?.pid).not.toBe(oldPid);
    } finally {
        await harness.close();
        await request;
    }
}, 30_000);

socketTest("three worker deaths trip the breaker while another worker keeps serving", async () => {
    const harness = await fixture();
    try {
        const socket = harness.host.server.socketPath;
        const first = await createAgentThroughHost(socket, harness.home);
        const second = await createAgentThroughHost(socket, harness.home);
        const index = Number(first.location!.worker_id.slice(1));
        for (let count = 0; count < 3; count += 1) {
            const pid = (await requestHostIdentity(first.location!.socket_path))!.pid;
            process.kill(pid, "SIGKILL");
            await waitFor(() => !alive(pid), "worker exit");
            if (count < 2) await waitFor(() => {
                const worker = harness.host.health.workers?.[index];
                return worker?.state === "replaced" && worker.pid !== pid;
            }, "replacement");
        }
        await waitFor(() => harness.host.health.workers?.[index]?.reason === "crash_loop", "crash breaker");
        expect(await locate(socket, first.id)).toMatchObject({ type: "agent_location_failed", reason: "worker_unavailable" });
        expect(await locate(socket, second.id)).toMatchObject({ type: "agent_location", worker_id: second.location?.worker_id });
        expect(await requestHostIdentity(socket)).toBeDefined();
    } finally { await harness.close(); }
}, 30_000);

socketTest("repeated startup failures trip one slot without stopping the host", async () => {
    const harness = await fixture({
        spawnSpec: (options) => options.index === 0 ? { command: process.execPath, args: ["-e", "process.exit(7)"] } : undefined,
    });
    try {
        await waitFor(() => harness.host.health.workers?.[0]?.reason === "crash_loop", "startup crash breaker");
        expect((await requestHostIdentity(harness.host.server.socketPath))?.workers_ready).toBe(1);
        const session = await createAgentThroughHost(harness.host.server.socketPath, harness.home);
        expect(session.location?.worker_id).toBe("w1");
        expect(harness.host.health.workers?.[0]).toMatchObject({ generation: 3, state: "unavailable", reason: "crash_loop" });
    } finally { await harness.close(); }
}, 30_000);

socketTest("a fresh pool with no session process up fails host startup", async () => {
    let home: string | undefined;
    await expect(fixture({
        workerCount: 1,
        prepare: async (dir) => { home = dir; return {}; },
        spawnSpec: () => ({ command: process.execPath, args: ["-e", "process.exit(7)"] }),
    })).rejects.toThrow();
    const left = Bun.spawnSync(["pgrep", "-f", home!]).stdout.toString().trim();
    expect(left).toBe("");
}, 30_000);

socketTest("closing the host while a replacement is starting reaps the replacement", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const harness = await fixture({ beforeStart: async (options) => {
        if (options.generation === 2) { entered.resolve(); await release.promise; }
    } });
    let closing: Promise<void> | undefined;
    try {
        const session = await createAgentThroughHost(harness.host.server.socketPath, harness.home);
        const pid = (await requestHostIdentity(session.location!.socket_path))!.pid;
        process.kill(pid, "SIGKILL");
        await entered.promise;
        closing = harness.close();
        release.resolve();
        await closing;
    } finally {
        release.resolve();
        if (closing === undefined) await harness.close();
    }
}, 30_000);

socketTest("a live process answering at the worker socket is not displaced", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const harness = await fixture({ beforeStart: async (options) => {
        if (options.generation === 2) { entered.resolve(); await release.promise; }
    } });
    let server: Server | undefined;
    try {
        const socket = harness.host.server.socketPath;
        const session = await createAgentThroughHost(socket, harness.home);
        const path = session.location!.socket_path;
        const oldPid = (await requestHostIdentity(path))!.pid;
        process.kill(oldPid, "SIGKILL");
        await waitFor(() => !alive(oldPid), "worker exit");
        await entered.promise;
        const other = await createAgentThroughHost(socket, harness.home);
        expect(other.location?.worker_id).not.toBe(session.location?.worker_id);
        expect(await requestHostIdentity(path)).toBeUndefined();
        await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        server = createServer((connection) => connection.once("data", () => connection.end(`${JSON.stringify({
            type: "host_identity", pid: process.pid, started_at: new Date().toISOString(),
        })}\n`)));
        await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(path, resolve); });
        expect((await requestHostIdentity(path))?.pid).toBe(process.pid);
        release.resolve();
        const index = Number(session.location!.worker_id.slice(1));
        await waitFor(() => harness.host.health.workers?.[index]?.reason === "worker_socket_busy", "socket refusal");
        expect((await requestHostIdentity(path))?.pid).toBe(process.pid);
        expect(await locate(socket, session.id)).toMatchObject({ type: "agent_location_failed", reason: "worker_unavailable" });
    } finally {
        release.resolve();
        if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
        await harness.close();
    }
}, 30_000);

socketTest("an inbox entry held during worker replacement is delivered once", async () => {
    const watching = Promise.withResolvers<WatchRuntimeContext>();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let address = "";
    const harness = await fixture({
        beforeStart: async (options) => { if (options.generation === 2) { entered.resolve(); await release.promise; } },
        async prepare(home) {
            const extension = join(home, "watch");
            await mkdir(extension);
            await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
                id: "test.watch", version: "1.0.0", sdk: "1", entrypoint: "extension.ts", capabilities: [],
                contributes: { watches: [{ id: "main", source_family: "arc" }] },
            }));
            await writeFile(join(extension, "extension.ts"), "export function activate() {}\n");
            return { extension, watch: [{ sourceFamily: "arc" as const, run: (context: WatchRuntimeContext) => {
                watching.resolve(context);
                return new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
            } }] };
        },
    });
    let client: AttachedAgentClient | undefined;
    try {
        const socket = harness.host.server.socketPath;
        const session = await createAgentThroughHost(socket, harness.home);
        address = session.id;
        client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
        expect((await client.receive()).type).toBe("history");
        const oldPid = (await requestHostIdentity(session.location!.socket_path))!.pid;
        process.kill(oldPid, "SIGKILL");
        await waitFor(() => !alive(oldPid), "worker exit");
        await entered.promise;
        const context = await watching.promise;
        await context.admit([{ id: "arc:held", kind: "arc.post", ts: new Date().toISOString(), actor: "lookout", session: null,
            payload: { text: "A map arrived." } }]);
        expect(inboxState(harness.home, address)).toEqual({ offset: 0, unread: 1 });
        expect(harness.stub.requests).toBe(0);
        release.resolve();
        await waitFor(async () => (await locate(socket, session.id)).type === "agent_location", "session location");
        client.close();
        client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
        expect((await client.receive()).type).toBe("history");
        while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
        expect(inboxState(harness.home, address)).toEqual({ offset: 1, unread: 0 });
        expect(harness.stub.requests).toBe(2);
    } finally {
        release.resolve();
        client?.close();
        await harness.close();
    }
}, 30_000);

for (const savedMessage of [false, true]) socketTest(`an inbox wake interrupted by a worker exit stays held (${savedMessage ? "saved message" : "no saved message"})`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const watching = Promise.withResolvers<WatchRuntimeContext>();
    let requests = 0;
    const interruptedRequest = savedMessage ? 2 : 1;
    const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            requests += 1;
            const current = requests;
            if (current === interruptedRequest) { entered.resolve(); await release.promise; }
            const tool = savedMessage && current === 1 ? "missing_tool"
                : current > interruptedRequest && current <= interruptedRequest + 2 ? "agent_inbox" : undefined;
            const delta = tool === undefined ? { role: "assistant", content: "The map is aboard." } : {
                role: "assistant", tool_calls: [{ index: 0, id: `call-${current}`, type: "function",
                    function: { name: tool, arguments: "{}" } }],
            };
            const chunk = { id: "x", object: "chat.completion.chunk", model: "stub-model",
                choices: [{ index: 0, delta, finish_reason: tool === undefined ? "stop" : "tool_calls" }] };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
        },
    });
    const provider = { port: server.port!, get requests() { return requests; }, close() { server.stop(true); } };
    const harness = await fixture({
        provider,
        async prepare(home) {
            const extension = join(home, "watch");
            await mkdir(extension);
            await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
                id: "test.watch", version: "1.0.0", sdk: "1", entrypoint: "extension.ts", capabilities: [],
                contributes: { watches: [{ id: "main", source_family: "arc" }] },
            }));
            await writeFile(join(extension, "extension.ts"), "export function activate() {}\n");
            return { extension, watch: [{ sourceFamily: "arc" as const, run: (context: WatchRuntimeContext) => {
                watching.resolve(context);
                return new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
            } }] };
        },
    });
    let client: AttachedAgentClient | undefined;
    try {
        const socket = harness.host.server.socketPath;
        const session = await createAgentThroughHost(socket, harness.home);
        const path = join(harness.home, "runtime", "sessions", `${session.id}.jsonl`);
        client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
        expect((await client.receive()).type).toBe("history");
        const context = await watching.promise;
        await context.admit([{ id: "arc:cut", kind: "arc.post", ts: new Date().toISOString(), actor: "lookout", session: null,
            payload: { text: "The first map arrived." } }]);
        await Promise.race([entered.promise, Bun.sleep(10_000).then(() => { throw new Error("Wake did not start"); })]);
        const before = await readSessionTurnState(path);
        expect(before.turnOpen).toBe(savedMessage);
        const oldPid = (await requestHostIdentity(session.location!.socket_path))!.pid;
        process.kill(oldPid, "SIGKILL");
        const index = Number(session.location!.worker_id.slice(1));
        await waitFor(() => harness.host.health.workers?.[index]?.state === "replaced", "replacement");
        expect(inboxState(harness.home, session.id)).toEqual({ offset: 0, unread: 1 });
        expect(requests).toBe(interruptedRequest);
        client.close();
        await waitFor(async () => (await locate(socket, session.id)).type === "agent_location", "session location");
        client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
        const history = await client.receive();
        expect(history.type).toBe("history");
        let noticeCount = 0;
        const noticeDeadline = AbortSignal.timeout(1_500);
        try {
            while (true) {
                const update = await client.receive(noticeDeadline);
                if (update.type === "notice" && update.key === "inbox" && update.count === 1) noticeCount += 1;
            }
        } catch {
            if (!noticeDeadline.aborted) throw new Error("Client closed before the held entry was delivered");
        }
        expect(noticeCount).toBe(1);
        expect(inboxState(harness.home, session.id)).toEqual({ offset: 0, unread: 1 });
        const log = await readFile(path, "utf8");
        const failedTurnRecords = log.split(WORKER_EXIT_TURN_MESSAGE).length - 1;
        expect(requests).toBe(interruptedRequest);
        expect(failedTurnRecords).toBe(savedMessage ? 1 : 0);
        if (history.type === "history") {
            expect(history.entries.filter((entry) => entry.kind === "error" && entry.detail === WORKER_EXIT_TURN_MESSAGE))
                .toHaveLength(savedMessage ? 1 : 0);
        }
        await context.admit([{ id: "arc:fresh", kind: "arc.post", ts: new Date().toISOString(), actor: "lookout", session: null,
            payload: { text: "The second map arrived." } }]);
        while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
        expect(requests).toBe(interruptedRequest + 3);
        expect(inboxState(harness.home, session.id)).toEqual({ offset: 2, unread: 0 });
        const delivered = await readFile(path, "utf8");
        expect(delivered.split("The first map arrived.")).toHaveLength(2);
        expect(delivered.split("The second map arrived.")).toHaveLength(2);
    } finally {
        release.resolve();
        client?.close();
        await harness.close();
    }
}, 30_000);

socketTest("an extension inbox wake interrupted before acknowledgement remains held", async () => {
    const recording = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const harness = await fixture({
        async prepare(home) {
            const extension = join(home, "sender");
            await mkdir(extension);
            await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
                id: "test.sender", version: "1.0.0", sdk: "1", entrypoint: "extension.ts",
                capabilities: ["requests.handle", "sessions.send"],
            }));
            await writeFile(join(extension, "extension.ts"), `export function activate(api) {
    api.requests.handle("send", (value) => api.sessions.send(value.id, value.text));
}\n`);
            return { extension };
        },
    });
    const original = HostInboxBridge.prototype.handle;
    const probe = spyOn(HostInboxBridge.prototype, "handle").mockImplementation(async function (this: HostInboxBridge, method, args, signal) {
        if (method === "noteDelivered") {
            recording.resolve();
            await release.promise;
            throw new Error("Delivery interrupted");
        }
        return await original.call(this, method, args, signal);
    });
    let client: AttachedAgentClient | undefined;
    try {
        const socket = harness.host.server.socketPath;
        const session = await createAgentThroughHost(socket, harness.home);
        client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
        expect((await client.receive()).type).toBe("history");
        expect(await harness.host.extensions.handleRequest("test.sender", "send", { id: session.id, text: "The first map is aboard." }, new AbortController().signal)).toBe("queued");
        await Promise.race([recording.promise, Bun.sleep(10_000).then(() => { throw new Error("Delivery was not recorded"); })]);
        expect(harness.stub.requests).toBe(0);
        const oldPid = (await requestHostIdentity(session.location!.socket_path))!.pid;
        process.kill(oldPid, "SIGKILL");
        const index = Number(session.location!.worker_id.slice(1));
        await waitFor(() => harness.host.health.workers?.[index]?.state === "replaced", "replacement");
        expect(inboxState(harness.home, session.id)).toEqual({ offset: 0, unread: 1 });
        client.close();
        await waitFor(async () => (await locate(socket, session.id)).type === "agent_location", "session location");
        client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
        expect((await client.receive()).type).toBe("history");
        await Bun.sleep(1_500);
        expect(harness.stub.requests).toBe(0);
        expect(inboxState(harness.home, session.id)).toEqual({ offset: 0, unread: 1 });
        probe.mockRestore();
        expect(await harness.host.extensions.handleRequest("test.sender", "send", { id: session.id, text: "The second map is aboard." }, new AbortController().signal)).toBe("queued");
        while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
        expect(harness.stub.requests).toBe(2);
        expect(inboxState(harness.home, session.id)).toEqual({ offset: 2, unread: 0 });
    } finally {
        release.resolve();
        client?.close();
        probe.mockRestore();
        await harness.close();
    }
}, 30_000);

function inboxState(home: string, id: string) {
    const inbox = Inbox.open(defaultInboxPath(home));
    try {
        const consumer = { nodeId: hostname(), label: id };
        return { offset: inbox.offsetOf(consumer), unread: inbox.unreadStats(consumer, { limit: 10, addresses: [id] }).count };
    } finally { inbox.close(); }
}

async function locate(socketPath: string, id: string): Promise<Record<string, unknown>> {
    const connection = await connectHost({ socketPath, signal: AbortSignal.timeout(2_000) });
    try {
        await connection.send({ type: "locate_agent", agent_id: id });
        return await connection.receiveWithin(2_000, "locate timed out") as Record<string, unknown>;
    } finally { connection.close(); }
}

async function waitFor(check: () => boolean | Promise<boolean>, name: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!await check()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${name}`);
        await Bun.sleep(20);
    }
}

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}
