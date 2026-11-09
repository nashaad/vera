import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";

import { createAgentThroughHost, resumeAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import type { ControlPeer } from "../../src/host/master/control.ts";
import { inProcessWorkerSocket } from "../../src/host/master/in-process.ts";
import { stopWorkerProcess, type WorkerStopIdentity } from "../../src/host/master/stop-worker.ts";
import * as supervisor from "../../src/host/master/supervisor.ts";
import { defaultHostLogPath } from "../../src/host/host-log.ts";
import { checkRecordIdentity, processIsAlive } from "../../src/host/process-identity.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { sessionShardIndex } from "../../src/host/shard.ts";
import { appendRestartRecord, defaultRestartRecordPath, listRestartRecords } from "../../src/store/restart-records.ts";
import {
    CRASH_CUT_MESSAGE, CRASH_QUEUED_PROMPT_MESSAGE, readSessionHeader, readSessionTurnState, SessionStore,
} from "../../src/store/session-store.ts";

interface CrashFixture {
    readonly home: string;
    readonly sessions: readonly { readonly id: string; readonly path: string }[];
}

async function fixture(): Promise<CrashFixture> {
    await fs.mkdir("/tmp/vera-dev", { recursive: true });
    const home = await fs.mkdtemp(join(await fs.realpath("/tmp/vera-dev"), "pd-scan-"));
    const directory = join(home, "runtime", "sessions");
    await fs.mkdir(directory, { recursive: true });
    const ids = ["crow-0", "crow-1"];
    expect(sessionShardIndex(ids[0]!, 2)).not.toBe(sessionShardIndex(ids[1]!, 2));
    const sessions = await Promise.all(ids.map(async (id, index) => {
        const path = join(directory, index === 0 ? "custom-name.jsonl" : `${id}.jsonl`);
        const store = await SessionStore.create(path, { sessionId: id, cwd: home });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "Inspect the map." }] }, { turnStart: true });
        return { id, path };
    }));
    await fs.writeFile(join(home, "runtime", "host.json"), JSON.stringify({
        schema_version: 3, pid: 2_147_483_646, started_at: new Date(Date.now() - 60_000).toISOString(),
        socket_path: join(home, "runtime", "host.sock"), build_id: "crashed-build",
    }));
    return { home, sessions };
}

function start(home: string, port = 1): Promise<ResidentHost> {
    return startResidentHost({
        home, processWorker: true, processWorkerCount: 2, skipStartupDiscovery: true,
        config: {
            schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
            providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${port}/v1`, credential: "none" } },
        },
    });
}

test("each crash tail is repaired on its owner without the master opening a session file", async () => {
    const data = await fixture();
    const paths = new Set(data.sessions.map((session) => session.path));
    const masterReads: Array<{ pid: number; path: string }> = [];
    const dispatches: Array<{ pid: number | undefined; index: number; session: { id: string; path: string } }> = [];
    const pids = new Map<number, number>();
    const originalOpen = fs.open;
    const originalRead = fs.readFile;
    const openProbe = spyOn(fs, "open").mockImplementation((async (path: Parameters<typeof fs.open>[0], ...args: unknown[]) => {
        if (paths.has(String(path))) masterReads.push({ pid: process.pid, path: String(path) });
        return await Reflect.apply(originalOpen, fs, [path, ...args]);
    }) as typeof fs.open);
    const readProbe = spyOn(fs, "readFile").mockImplementation(((path: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
        if (paths.has(String(path))) masterReads.push({ pid: process.pid, path: String(path) });
        return Reflect.apply(originalRead, fs, [path, ...args]);
    }) as typeof fs.readFile);
    const startWorker = supervisor.startSessionWorkerSupervisor;
    const workerProbe = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation((options) => startWorker({
        ...options,
        onSpawn(pid, startedAt) {
            pids.set(options.index!, pid);
            options.onSpawn?.(pid, startedAt);
        },
        onConnected(peer) {
            const request = peer.request;
            peer.request = function<T>(this: ControlPeer, method: string, args: readonly unknown[] = [], signal?: AbortSignal): Promise<T> {
                if (method === "worker.recoverCrashSession") {
                    dispatches.push({ pid: pids.get(options.index!), index: options.index!, session: args[0] as { id: string; path: string } });
                }
                return request.call(this, method, args, signal) as Promise<T>;
            };
            options.onConnected(peer);
        },
    }));
    let host: ResidentHost | undefined;
    try {
        await readSessionHeader(data.sessions[0]!.path);
        await readSessionTurnState(data.sessions[1]!.path);
        expect(masterReads).toEqual(data.sessions.map((session) => ({ pid: process.pid, path: session.path })));
        masterReads.length = 0;
        host = await start(data.home);
        expect(masterReads).toEqual([]);
        openProbe.mockRestore();
        readProbe.mockRestore();
        for (const session of data.sessions) {
            const index = sessionShardIndex(session.id, 2);
            const identity = await requestHostIdentity(inProcessWorkerSocket(data.home, index));
            expect(identity?.pid).not.toBe(process.pid);
            expect(dispatches).toContainEqual({ pid: identity!.pid, index, session });
            expect((await fs.readFile(session.path, "utf8")).split(CRASH_CUT_MESSAGE)).toHaveLength(2);
        }
        const records = listRestartRecords(defaultRestartRecordPath(data.home));
        expect(records.map((record) => [record.session_id, record.cause]).sort())
            .toEqual(data.sessions.map((session) => [session.id, "crash"]).sort());
        const events = (await fs.readFile(defaultHostLogPath(data.home), "utf8")).trim().split("\n")
            .map((line) => JSON.parse(line)).filter((event) => event.type === "restart_turns_recorded");
        expect(events).toHaveLength(1);
        expect(events[0].message).toBe("2 session(s) had a turn open at the last exit");
    } finally {
        openProbe.mockRestore();
        readProbe.mockRestore();
        await host?.close();
        workerProbe.mockRestore();
        await fs.rm(data.home, { recursive: true, force: true });
    }
}, 40_000);

test("two files with the same session ID are both repaired", async () => {
    const data = await fixture();
    const first = data.sessions[0]!;
    const alias = join(data.home, "runtime", "sessions", "another-name.jsonl");
    const store = await SessionStore.create(alias, { sessionId: first.id, cwd: data.home });
    await store.appendMessage({ role: "user", content: [{ type: "text", text: "Check the sails." }] }, { turnStart: true });
    let host: ResidentHost | undefined;
    try {
        host = await start(data.home);
        for (const path of [first.path, alias]) {
            expect((await fs.readFile(path, "utf8")).split(CRASH_CUT_MESSAGE)).toHaveLength(2);
        }
        expect(listRestartRecords(defaultRestartRecordPath(data.home)).filter((record) => record.session_id === first.id))
            .toHaveLength(1);
    } finally {
        await host?.close();
        await fs.rm(data.home, { recursive: true, force: true });
    }
}, 40_000);

test("a queued prompt without an open turn is recorded and recovered", async () => {
    const data = await fixture();
    const id = "queued-only";
    const path = join(data.home, "runtime", "sessions", `${id}.jsonl`);
    const store = await SessionStore.create(path, { sessionId: id, cwd: data.home });
    await store.appendQueuedPrompt("held", { content: "Check the sails." });
    let host: ResidentHost | undefined;
    try {
        host = await start(data.home);
        expect((await fs.readFile(path, "utf8")).split(CRASH_QUEUED_PROMPT_MESSAGE)).toHaveLength(2);
        expect((await SessionStore.open(path)).queuedPrompts()).toEqual([]);
        expect(listRestartRecords(defaultRestartRecordPath(data.home)).filter((record) => record.session_id === id))
            .toMatchObject([{ session_id: id, cause: "crash" }]);
    } finally {
        await host?.close();
        await fs.rm(data.home, { recursive: true, force: true });
    }
}, 40_000);

test("session processes send concurrent restart-record clears to the master", async () => {
    const data = await fixture();
    const peers = new Map<number, ControlPeer>();
    const startWorker = supervisor.startSessionWorkerSupervisor;
    const workerProbe = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation((options) => startWorker({
        ...options,
        onConnected(peer) { peers.set(options.index!, peer); options.onConnected(peer); },
    }));
    let host: ResidentHost | undefined;
    let renameProbe: ReturnType<typeof spyOn<typeof fs, "rename">> | undefined;
    try {
        host = await start(data.home);
        const recordPath = defaultRestartRecordPath(data.home);
        appendRestartRecord({ session_id: "keep", cause: "crash", at: new Date().toISOString() }, recordPath);
        const renamedBy: number[] = [];
        const rename = fs.rename;
        renameProbe = spyOn(fs, "rename").mockImplementation(async (from, to) => {
            if (String(to) === recordPath) renamedBy.push(process.pid);
            await rename(from, to);
        });
        await Promise.all(data.sessions.map((session) => {
            const index = sessionShardIndex(session.id, 2);
            return peers.get(index)!.request("session.recordTrashOutcome", [session.id, [], true]);
        }));
        expect(renamedBy).toEqual([process.pid, process.pid]);
        expect(listRestartRecords(recordPath).map((record) => record.session_id)).toEqual(["keep"]);
    } finally {
        renameProbe?.mockRestore();
        await host?.close();
        workerProbe.mockRestore();
        await fs.rm(data.home, { recursive: true, force: true });
    }
}, 40_000);

test("the startup scan leaves old sessions and paths outside its directory untouched", async () => {
    const data = await fixture();
    const path = join(data.home, "runtime", "sessions", "older.jsonl");
    const store = await SessionStore.create(path, { sessionId: "older", cwd: data.home });
    await store.appendMessage({ role: "user", content: [{ type: "text", text: "Read the chart." }] }, { turnStart: true });
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(path, old, old);
    const before = await fs.readFile(path, "utf8");
    const outsidePath = join(data.home, "outside.jsonl");
    const outside = await SessionStore.create(outsidePath, { sessionId: "outside", cwd: data.home });
    await outside.appendMessage({ role: "user", content: [{ type: "text", text: "Check the anchor." }] }, { turnStart: true });
    const outsideBefore = await fs.readFile(outsidePath, "utf8");
    let host: ResidentHost | undefined;
    try {
        host = await start(data.home);
        expect(await fs.readFile(path, "utf8")).toBe(before);
        expect(await fs.readFile(outsidePath, "utf8")).toBe(outsideBefore);
        expect(listRestartRecords(defaultRestartRecordPath(data.home))
            .some((record) => record.session_id === "older" || record.session_id === "outside")).toBe(false);
    } finally {
        await host?.close();
        await fs.rm(data.home, { recursive: true, force: true });
    }
}, 40_000);

for (const scenario of ["adopt", "replace", "unready_adoption", "unready_replacement"] as const) test({
    adopt: "a master killed during the scan is followed by one complete recovery",
    replace: "a master and session process killed during the scan are followed by one complete recovery",
    unready_adoption: "an interrupted scan continues when an adopted process is not ready",
    unready_replacement: "an interrupted scan continues when a replacement process is not ready",
}[scenario], async () => {
    const data = await fixture();
    const finished = data.sessions[0]!;
    const held = data.sessions[1]!;
    const loseWorker = scenario === "replace" || scenario === "unready_replacement";
    const unready = scenario === "unready_adoption" || scenario === "unready_replacement";
    const release = Promise.withResolvers<void>();
    let restoreWorker: (() => void) | undefined;
    const previousDev = process.env.VERA_DEV_INSTANCE;
    process.env.VERA_DEV_INSTANCE = "pooldef dev";
    const child = Bun.spawn([process.execPath, "test/host/fixtures/pool-startup-crash-host.ts"], {
        cwd: process.cwd(),
        env: { ...process.env, VERA_HOME: data.home, VERA_DEV_INSTANCE: "pooldef dev", POOL_CRASH_SCAN_HELD_ID: held.id },
        stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const workers: WorkerStopIdentity[] = [];
    let host: ResidentHost | undefined;
    try {
        const deadline = Date.now() + 10_000;
        while (true) {
            if (child.exitCode !== null) throw new Error(`Master exited during recovery: ${await stderr}`);
            const paused = await fs.stat(join(data.home, "scan-paused")).then(() => true, () => false);
            const repaired = (await fs.readFile(finished.path, "utf8")).includes(CRASH_CUT_MESSAGE);
            if (paused && repaired) break;
            if (Date.now() >= deadline) throw new Error("Crash scan did not pause after the first repair");
            await Bun.sleep(25);
        }
        expect(listRestartRecords(defaultRestartRecordPath(data.home)).filter((record) => record.session_id === held.id))
            .toHaveLength(1);
        expect(await fs.readFile(held.path, "utf8")).not.toContain(CRASH_CUT_MESSAGE);
        for (let index = 0; index < 2; index += 1) {
            const identity = await requestHostIdentity(inProcessWorkerSocket(data.home, index));
            if (identity === undefined) throw new Error("Session process identity is unavailable");
            workers.push({ pid: identity.pid, started_at: identity.started_at });
        }
        child.kill("SIGKILL");
        await child.exited;
        if (loseWorker) {
            const worker = workers[sessionShardIndex(held.id, 2)]!;
            expect(checkRecordIdentity(worker)).toBe("match");
            process.kill(worker.pid, "SIGKILL");
            const deadline = Date.now() + 10_000;
            while (processIsAlive(worker.pid) && checkRecordIdentity(worker) === "match") {
                if (Date.now() >= deadline) throw new Error("Session process did not exit");
                await Bun.sleep(25);
            }
        }
        if (unready) {
            const startWorker = supervisor.startSessionWorkerSupervisor;
            let failed = false;
            const probe = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation(async (options) => {
                if (options.index !== sessionShardIndex(held.id, 2)) return await startWorker(options);
                if (!failed) {
                    failed = true;
                    if (options.adopt !== undefined) {
                        const adopted = await startWorker(options);
                        await adopted.close();
                    }
                    throw new Error("Session process failed to start");
                }
                await release.promise;
                return await startWorker(options);
            });
            restoreWorker = () => probe.mockRestore();
        }
        host = await start(data.home);
        if (unready) {
            const events = (await fs.readFile(defaultHostLogPath(data.home), "utf8")).trim().split("\n")
                .map((line) => JSON.parse(line));
            expect(events.some((event) => event.type === "restart_scan_failed")).toBe(true);
            expect(await fs.readFile(held.path, "utf8")).not.toContain(CRASH_CUT_MESSAGE);
            release.resolve();
            const deadline = Date.now() + 10_000;
            while (!host.health.workers?.some((worker) => worker.index === sessionShardIndex(held.id, 2)
                && (worker.state === "ready" || worker.state === "replaced"))) {
                if (Date.now() >= deadline) throw new Error("Session process did not recover");
                await Bun.sleep(25);
            }
            expect(await fs.readFile(held.path, "utf8")).not.toContain(CRASH_CUT_MESSAGE);
            expect((await resumeAgentThroughHost(host.server.socketPath, held.path)).id).toBe(held.id);
        }
        for (let index = 0; index < workers.length; index += 1) {
            const identity = await requestHostIdentity(inProcessWorkerSocket(data.home, index));
            if ((loseWorker || unready) && index === sessionShardIndex(held.id, 2)) {
                expect(identity?.pid).not.toBe(workers[index]!.pid);
            } else {
                expect(identity?.pid).toBe(workers[index]!.pid);
            }
        }
        for (const session of data.sessions) {
            expect((await fs.readFile(session.path, "utf8")).split(CRASH_CUT_MESSAGE)).toHaveLength(2);
        }
        const records = listRestartRecords(defaultRestartRecordPath(data.home));
        expect(records.map((record) => [record.session_id, record.cause]).sort())
            .toEqual(data.sessions.map((session) => [session.id, "crash"]).sort());
    } finally {
        release.resolve();
        restoreWorker?.();
        if (previousDev === undefined) delete process.env.VERA_DEV_INSTANCE; else process.env.VERA_DEV_INSTANCE = previousDev;
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await child.exited;
        await host?.close();
        for (const worker of workers) await stopWorkerProcess(worker);
        await stderr;
        await fs.rm(data.home, { recursive: true, force: true });
    }
}, 40_000);

test("the crash scan shares the session-process startup deadline", async () => {
    const data = await fixture();
    const startWorker = supervisor.startSessionWorkerSupervisor;
    const probe = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation(async (options) => {
        if (options.index === 1) await Bun.sleep(7_000);
        return await startWorker({
            ...options,
            onConnected(peer) {
                const request = peer.request;
                peer.request = function<T>(this: ControlPeer, method: string, args: readonly unknown[] = [], signal?: AbortSignal): Promise<T> {
                    if (method === "worker.discoverCrashSessions") {
                        return new Promise((_resolve, reject) => {
                            const abort = () => reject(signal?.reason ?? new Error("Scan timed out"));
                            if (signal?.aborted) abort();
                            else signal?.addEventListener("abort", abort, { once: true });
                        });
                    }
                    return request.call(this, method, args, signal) as Promise<T>;
                };
                options.onConnected(peer);
            },
        });
    });
    let host: ResidentHost | undefined;
    try {
        const started = performance.now();
        host = await start(data.home);
        expect(performance.now() - started).toBeLessThan(14_000);
        const events = (await fs.readFile(defaultHostLogPath(data.home), "utf8")).trim().split("\n")
            .map((line) => JSON.parse(line));
        expect(events.some((event) => event.type === "restart_scan_failed")).toBe(true);
        const session = data.sessions[0]!;
        expect(await fs.readFile(session.path, "utf8")).not.toContain(CRASH_CUT_MESSAGE);
        expect((await resumeAgentThroughHost(host.server.socketPath, session.path)).id).toBe(session.id);
        expect((await fs.readFile(session.path, "utf8")).split(CRASH_CUT_MESSAGE)).toHaveLength(2);
    } finally {
        probe.mockRestore();
        await host?.close();
        await fs.rm(data.home, { recursive: true, force: true });
    }
}, 25_000);

test("an unavailable shard is logged and its session is repaired on resume", async () => {
    const data = await fixture();
    const missing = data.sessions.find((session) => sessionShardIndex(session.id, 2) === 1)!;
    const startWorker = supervisor.startSessionWorkerSupervisor;
    const release = Promise.withResolvers<void>();
    let first = true;
    const probe = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation((options) => {
        if (options.index !== 1) return startWorker(options);
        if (first) { first = false; return Promise.reject(new Error("Session process failed to start")); }
        return release.promise.then(() => startWorker(options));
    });
    let host: ResidentHost | undefined;
    try {
        host = await start(data.home);
        expect(await fs.readFile(missing.path, "utf8")).not.toContain(CRASH_CUT_MESSAGE);
        const events = (await fs.readFile(defaultHostLogPath(data.home), "utf8")).trim().split("\n")
            .map((line) => JSON.parse(line));
        expect(events.some((event) => event.type === "restart_scan_failed")).toBe(true);
        release.resolve();
        const deadline = Date.now() + 10_000;
        while (!host.health.workers?.some((worker) => worker.index === 1
            && (worker.state === "ready" || worker.state === "replaced"))) {
            if (Date.now() >= deadline) throw new Error("Session process did not recover");
            await Bun.sleep(25);
        }
        expect((await resumeAgentThroughHost(host.server.socketPath, missing.path)).id).toBe(missing.id);
        expect((await fs.readFile(missing.path, "utf8")).split(CRASH_CUT_MESSAGE)).toHaveLength(2);
    } finally {
        release.resolve();
        probe.mockRestore();
        await host?.close();
        await fs.rm(data.home, { recursive: true, force: true });
    }
}, 40_000);

test("a failed shard scan is logged and its session is repaired on resume", async () => {
    const data = await fixture();
    const session = data.sessions[0]!;
    const startWorker = supervisor.startSessionWorkerSupervisor;
    let fail = true;
    const probe = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation((options) => startWorker({
        ...options,
        onConnected(peer) {
            const request = peer.request;
            peer.request = function<T>(this: ControlPeer, method: string, args: readonly unknown[] = [], signal?: AbortSignal): Promise<T> {
                const candidate = args[0] as { id?: string } | undefined;
                if (fail && method === "worker.recoverCrashSession" && candidate?.id === session.id) {
                    return Promise.reject(new Error("Session scan failed"));
                }
                return request.call(this, method, args, signal) as Promise<T>;
            };
            options.onConnected(peer);
        },
    }));
    let host: ResidentHost | undefined;
    try {
        host = await start(data.home);
        expect(await fs.readFile(session.path, "utf8")).not.toContain(CRASH_CUT_MESSAGE);
        const events = (await fs.readFile(defaultHostLogPath(data.home), "utf8")).trim().split("\n")
            .map((line) => JSON.parse(line));
        expect(events.some((event) => event.type === "restart_scan_failed" && event.message.includes("Session scan failed"))).toBe(true);
        fail = false;
        expect((await resumeAgentThroughHost(host.server.socketPath, session.path)).id).toBe(session.id);
        expect((await fs.readFile(session.path, "utf8")).split(CRASH_CUT_MESSAGE)).toHaveLength(2);
    } finally {
        probe.mockRestore();
        await host?.close();
        await fs.rm(data.home, { recursive: true, force: true });
    }
}, 40_000);

test("a resume during crash recovery waits for the repaired tail", async () => {
    const data = await fixture();
    const session = data.sessions[0]!;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const startWorker = supervisor.startSessionWorkerSupervisor;
    const probe = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation((options) => startWorker({
        ...options,
        async handler(method, args, signal) {
            const result = await options.handler(method, args, signal);
            if (method === "recovery.recordCrash" && args[0] === session.id) {
                entered.resolve();
                await release.promise;
            }
            return result;
        },
    }));
    let host: ResidentHost | undefined;
    let resuming: ReturnType<typeof resumeAgentThroughHost> | undefined;
    const starting = start(data.home);
    void starting.catch(() => {});
    try {
        await Promise.race([entered.promise, Bun.sleep(10_000).then(() => { throw new Error("Crash recovery did not start"); })]);
        expect(listRestartRecords(defaultRestartRecordPath(data.home)).some((record) => record.session_id === session.id)).toBe(true);
        expect(await fs.readFile(session.path, "utf8")).not.toContain(CRASH_CUT_MESSAGE);
        expect((await requestHostIdentity(join(data.home, "runtime", "host.sock")))?.pid).toBe(process.pid);
        expect(JSON.parse(await fs.readFile(join(data.home, "runtime", "host.json"), "utf8")).pid).toBe(2_147_483_646);
        let resumed = false;
        resuming = resumeAgentThroughHost(join(data.home, "runtime", "host.sock"), session.path)
            .finally(() => { resumed = true; });
        void resuming.catch(() => {});
        await Bun.sleep(100);
        expect(resumed).toBe(false);
        release.resolve();
        host = await starting;
        expect((await resuming).id).toBe(session.id);
        expect((await fs.readFile(session.path, "utf8")).split(CRASH_CUT_MESSAGE)).toHaveLength(2);
        expect(listRestartRecords(defaultRestartRecordPath(data.home)).filter((record) => record.session_id === session.id)).toHaveLength(1);
    } finally {
        release.resolve();
        host ??= await starting.catch(() => undefined);
        await resuming?.catch(() => undefined);
        await host?.close();
        probe.mockRestore();
        await fs.rm(data.home, { recursive: true, force: true });
    }
}, 40_000);

test("identity answers while a crash record waits for disk sync", async () => {
    const data = await fixture();
    const recordPath = defaultRestartRecordPath(data.home);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalOpen = fs.open;
    let held = false;
    const probe = spyOn(fs, "open").mockImplementation((async (path: Parameters<typeof fs.open>[0], ...args: unknown[]) => {
        const file = await Reflect.apply(originalOpen, fs, [path, ...args]);
        if (String(path) === recordPath && args[0] === "a" && !held) {
            held = true;
            const sync = file.sync.bind(file);
            file.sync = async () => {
                entered.resolve();
                await release.promise;
                await sync();
            };
        }
        return file;
    }) as typeof fs.open);
    let host: ResidentHost | undefined;
    const starting = start(data.home);
    void starting.catch(() => {});
    try {
        await Promise.race([entered.promise, Bun.sleep(10_000).then(() => { throw new Error("Crash record did not reach disk sync"); })]);
        const identity = await Promise.race([
            requestHostIdentity(join(data.home, "runtime", "host.sock")),
            Bun.sleep(1_000).then(() => { throw new Error("Identity waited for crash record sync"); }),
        ]);
        expect(identity?.pid).toBe(process.pid);
        release.resolve();
        host = await starting;
        expect(listRestartRecords(recordPath)).toHaveLength(2);
    } finally {
        release.resolve();
        host ??= await starting.catch(() => undefined);
        await host?.close();
        probe.mockRestore();
        await fs.rm(data.home, { recursive: true, force: true });
    }
}, 40_000);

test("a session created during the scan is left running on its assigned worker", async () => {
    const data = await fixture();
    const directory = join(data.home, "runtime", "sessions");
    const listing = Promise.withResolvers<void>();
    const releaseListing = Promise.withResolvers<void>();
    const turn = Promise.withResolvers<void>();
    const releaseTurn = Promise.withResolvers<void>();
    const originalReaddir = fs.readdir;
    let held = false;
    const readdirProbe = spyOn(fs, "readdir").mockImplementation((async (path: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
        if (String(path) === directory && !held) {
            held = true;
            listing.resolve();
            await releaseListing.promise;
        }
        return await Reflect.apply(originalReaddir, fs, [path, ...args]);
    }) as typeof fs.readdir);
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            turn.resolve();
            await releaseTurn.promise;
            return new Response('data: {"id":"x","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"The map is aboard."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                { headers: { "content-type": "text/event-stream" } });
        },
    });
    let host: ResidentHost | undefined;
    let client: AttachedAgentClient | undefined;
    const starting = start(data.home, stub.port);
    void starting.catch(() => {});
    try {
        await Promise.race([listing.promise, Bun.sleep(10_000).then(() => { throw new Error("Crash scan did not list sessions"); })]);
        const socket = join(data.home, "runtime", "host.sock");
        let selected: Awaited<ReturnType<typeof createAgentThroughHost>> | undefined;
        for (let attempt = 0; attempt < 64; attempt += 1) {
            const created = await createAgentThroughHost(socket, data.home);
            const index = Number(created.location!.worker_id.slice(1));
            if (sessionShardIndex(created.id, 2) !== index) { selected = created; break; }
        }
        if (selected === undefined) throw new Error("No session was assigned away from its hash shard");
        client = await attachAgent({ socketPath: selected.location!.socket_path, agentId: selected.id });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Inspect the crow's map." });
        await Promise.race([turn.promise, Bun.sleep(10_000).then(() => { throw new Error("Turn did not start"); })]);
        releaseListing.resolve();
        host = await starting;
        const path = join(directory, `${selected.id}.jsonl`);
        expect(await fs.readFile(path, "utf8")).not.toContain(CRASH_CUT_MESSAGE);
        expect(listRestartRecords(defaultRestartRecordPath(data.home)).some((record) => record.session_id === selected!.id)).toBe(false);
        releaseTurn.resolve();
        while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
    } finally {
        releaseListing.resolve();
        releaseTurn.resolve();
        client?.close();
        host ??= await starting.catch(() => undefined);
        await host?.close();
        stub.stop(true);
        readdirProbe.mockRestore();
        await fs.rm(data.home, { recursive: true, force: true });
    }
}, 40_000);
