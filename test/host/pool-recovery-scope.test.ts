import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAgentThroughHost, resumeAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachReconnectingAgent } from "../../src/host/reconnecting-agent-client.ts";
import type { AttachedAgentClient } from "../../src/host/attached-client.ts";
import type { ControlPeer } from "../../src/host/master/control.ts";
import * as supervisor from "../../src/host/master/supervisor.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { CRASH_CUT_MESSAGE, SessionStore, WORKER_EXIT_TURN_MESSAGE } from "../../src/store/session-store.ts";
import * as sessionStore from "../../src/store/session-store.ts";

interface RecoveryEntry {
    readonly id: string;
    readonly path: string;
}

interface FixtureOptions {
    readonly count: number;
    readonly olderTail?: boolean;
    readonly pendingDelivery?: boolean;
    readonly holdResume?: "before" | "after";
}

async function fixture(options: FixtureOptions) {
    const optionsForFixture = options;
    const home = await mkdtemp("/private/tmp/vera-dev/h8scope-");
    const directory = join(home, "runtime", "sessions");
    const webRoot = join(home, "web");
    await mkdir(directory, { recursive: true });
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    const stored = await Promise.all(Array.from({ length: options.count }, async (_, index) => {
        const id = `stored-${index}`;
        const path = join(directory, `${id}.jsonl`);
        const store = await SessionStore.create(path, { sessionId: id, cwd: home });
        if (options.olderTail && index === 0) {
            await store.appendMessage({ role: "user", content: [{ type: "text", text: "An earlier turn." }] }, { turnStart: true });
        }
        if (options.pendingDelivery && index === 0) {
            await store.recordDelivery({ id: "pending-map", sourceAgentId: "lookout", content: "A map arrived." });
        }
        return { id, path, bytes: await readFile(path) };
    }));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const resumeHeld = Promise.withResolvers<void>();
    const releaseResume = Promise.withResolvers<void>();
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            entered.resolve();
            await release.promise;
            return new Response('data: {"id":"x","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"The map is aboard."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                { headers: { "content-type": "text/event-stream" } });
        },
    });
    const pids = new Set<number>();
    const batches: RecoveryEntry[][] = [];
    const start = supervisor.startSessionWorkerSupervisor;
    const probe = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation((options) => start({
        ...options,
        onSpawn(pid) { pids.add(pid); options.onSpawn?.(pid); },
        onConnected(peer) {
            const request = peer.request;
            peer.request = function<T>(this: ControlPeer, method: string, args: readonly unknown[] = [], signal?: AbortSignal): Promise<T> {
                if (method === "worker.recover") batches.push(args[0] as RecoveryEntry[]);
                if (method === "session.resume" && options.generation === 1 && optionsForFixture.holdResume === "before") {
                    resumeHeld.resolve();
                    return releaseResume.promise.then(() => request.call(this, method, args, signal) as Promise<T>);
                }
                if (method === "session.resume" && options.generation === 1 && optionsForFixture.holdResume === "after") {
                    const result = request.call(this, method, args, signal) as Promise<T>;
                    return result.then(async () => {
                        resumeHeld.resolve();
                        await releaseResume.promise;
                        throw new Error("Worker reply was lost");
                    });
                }
                return request.call(this, method, args, signal) as Promise<T>;
            };
            options.onConnected(peer);
        },
        onEvent(event, value) {
            if (optionsForFixture.holdResume === undefined || event !== "roster_delta") options.onEvent(event, value);
        },
    }));
    let host: ResidentHost;
    try {
        host = await startResidentHost({
            home, webRoot, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
            },
        });
    } catch (error) {
        release.resolve();
        releaseResume.resolve();
        stub.stop(true);
        probe.mockRestore();
        await rm(home, { recursive: true, force: true });
        throw error;
    }
    if (host.annexPid !== undefined) pids.add(host.annexPid);
    let workerLost = false;
    let forbiddenReads = 0;
    const readSnapshot = sessionStore.readSessionSnapshot;
    const readProbe = options.holdResume === "before"
        ? spyOn(sessionStore, "readSessionSnapshot").mockImplementation(async (path) => {
            if (workerLost && path === stored[0]?.path) {
                forbiddenReads += 1;
                throw new Error("Unopened session was read during recovery");
            }
            return await readSnapshot(path);
        })
        : undefined;
    let client: AttachedAgentClient | undefined;
    return {
        home, host, stored, batches,
        async interrupt() {
            const socket = host.server.socketPath;
            const session = await createAgentThroughHost(socket, home);
            client = await attachReconnectingAgent({ socketPath: () => socket, agentId: session.id, buildId: host.buildId, initialLocation: session.location });
            expect((await client.receive()).type).toBe("history");
            await client.send({ type: "prompt", content: "Inspect the map." });
            await Promise.race([entered.promise, Bun.sleep(10_000).then(() => { throw new Error("Provider did not start"); })]);
            const pid = (await requestHostIdentity(session.location!.socket_path))!.pid;
            const started = performance.now();
            process.kill(pid, "SIGKILL");
            await waitFor(() => host.health.workers?.[0]?.state === "replaced", "replacement");
            expect(performance.now() - started).toBeLessThan(10_000);
            const path = join(directory, `${session.id}.jsonl`);
            expect((await readFile(path, "utf8")).split(WORKER_EXIT_TURN_MESSAGE)).toHaveLength(2);
            expect(batches).toHaveLength(1);
            expect(batches[0]!.map((item) => item.id)).toEqual([session.id]);
        },
        async interruptOpening(expectSaved: boolean) {
            const session = stored[0]!;
            const opening = resumeAgentThroughHost(host.server.socketPath, session.path).then(() => undefined, () => undefined);
            try {
                await Promise.race([
                    (expectSaved ? Promise.all([resumeHeld.promise, entered.promise]).then(() => undefined) : resumeHeld.promise),
                    Bun.sleep(10_000).then(() => { throw new Error("Resume did not reach its gate"); }),
                ]);
                const pid = (await requestHostIdentity(join(home, "runtime", "w0.sock")))!.pid;
                process.kill(pid, "SIGKILL");
                workerLost = true;
                releaseResume.resolve();
                await waitFor(() => host.health.workers?.[0]?.state === "replaced", "replacement");
                await opening;
                expect(batches).toHaveLength(1);
                expect(batches[0]!.map((item) => item.id)).toEqual(expectSaved ? [session.id] : []);
                if (readProbe !== undefined) {
                    expect(forbiddenReads).toBe(0);
                    await expect(sessionStore.readSessionSnapshot(session.path)).rejects.toThrow("Unopened session was read during recovery");
                    readProbe.mockRestore();
                }
                const log = await readFile(session.path, "utf8");
                expect(log.split(WORKER_EXIT_TURN_MESSAGE)).toHaveLength(expectSaved ? 2 : 1);
            } finally {
                releaseResume.resolve();
                await opening;
            }
        },
        async close() {
            release.resolve();
            releaseResume.resolve();
            client?.close();
            try { await host.close(); }
            finally {
                stub.stop(true);
                probe.mockRestore();
                readProbe?.mockRestore();
                try {
                    await waitFor(() => [...pids].every((pid) => !alive(pid)), "children to exit");
                    expect([...pids].filter(alive)).toEqual([]);
                } finally { await rm(home, { recursive: true, force: true }); }
            }
        },
    };
}

test("replacement recovers its resident without opening a shard of stored sessions", async () => {
    const harness = await fixture({ count: 200 });
    try {
        await harness.interrupt();
        for (const entry of harness.stored) expect(await readFile(entry.path)).toEqual(entry.bytes);
    } finally { await harness.close(); }
}, 40_000);

test("replacement leaves an older stored crash tail for normal recovery on open", async () => {
    const harness = await fixture({ count: 1, olderTail: true });
    try {
        const stored = harness.stored[0]!;
        await harness.interrupt();
        expect(await readFile(stored.path)).toEqual(stored.bytes);
        const resumed = await resumeAgentThroughHost(harness.host.server.socketPath, stored.path);
        expect(resumed.id).toBe(stored.id);
        const log = await readFile(stored.path, "utf8");
        expect(log.split(CRASH_CUT_MESSAGE)).toHaveLength(2);
        expect(log).not.toContain(WORKER_EXIT_TURN_MESSAGE);
    } finally { await harness.close(); }
}, 40_000);

test("a worker lost before a resume reply still repairs the turn opened between snapshots", async () => {
    const harness = await fixture({ count: 1, pendingDelivery: true, holdResume: "after" });
    try { await harness.interruptOpening(true); }
    finally { await harness.close(); }
}, 40_000);

test("a worker lost before an old session opens leaves the old crash tail alone", async () => {
    const harness = await fixture({ count: 1, olderTail: true, holdResume: "before" });
    try {
        const stored = harness.stored[0]!;
        await harness.interruptOpening(false);
        expect(await readFile(stored.path)).toEqual(stored.bytes);
        await resumeAgentThroughHost(harness.host.server.socketPath, stored.path);
        const log = await readFile(stored.path, "utf8");
        expect(log.split(CRASH_CUT_MESSAGE)).toHaveLength(2);
        expect(log).not.toContain(WORKER_EXIT_TURN_MESSAGE);
    } finally { await harness.close(); }
}, 40_000);

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 12_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await Bun.sleep(20);
    }
}

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}
