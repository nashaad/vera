import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { closeSync, constants, openSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { createAgentThroughHost, resumeAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import type { ControlPeer } from "../../src/host/master/control.ts";
import { MasterInboxBridge } from "../../src/host/master/inbox.ts";
import * as supervisor from "../../src/host/master/supervisor.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { runScheduleOperationThroughHost } from "../../src/host/schedule-client.ts";
import { sessionShardIndex } from "../../src/host/shard.ts";
import { defaultSchedulePath, ScheduleStore } from "../../src/scheduler/store.ts";
import { defaultInboxPath, Inbox } from "../../src/store/inbox.ts";
import { defaultSessionDirectory, SessionStore } from "../../src/store/session-store.ts";
import type { WatchRuntimeContext } from "../../src/watch/source.ts";
import { startScheduleWakeProvider } from "../support/schedule-wake-provider.ts";

interface PoolProbe {
    readonly pids: Map<number, number>;
    readonly allPids: number[];
    readonly peers: Map<number, ControlPeer>;
    readonly ready: Set<number>;
    restore(): void;
}

function probePool(beforeStart?: (index: number, generation: number) => Promise<void>): PoolProbe {
    const pids = new Map<number, number>();
    const allPids: number[] = [];
    const peers = new Map<number, ControlPeer>();
    const ready = new Set<number>();
    const start = supervisor.startSessionWorkerSupervisor;
    const spy = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation(async (options) => {
        const index = options.index ?? 0;
        await beforeStart?.(index, options.generation);
        const worker = await start({
            ...options,
            onSpawn(pid) { pids.set(index, pid); allPids.push(pid); options.onSpawn?.(pid); },
            onConnected(peer) { peers.set(index, peer); options.onConnected(peer); },
        });
        ready.add(index);
        return worker;
    });
    return { pids, allPids, peers, ready, restore: () => spy.mockRestore() };
}

function poolOptions(home: string, port: number, extension?: string) {
    return {
        home, processWorker: true, processWorkerCount: 3, skipStartupDiscovery: true,
        config: {
            schema_version: 1 as const, provider: "stub", model: "stub-model", approval_mode: "auto" as const,
            curated_models_url: "", inbox: { admit: ["schedule", "arc"] },
            ...(extension === undefined ? {} : { extensions: [{ path: extension, enabled: true, config: {} }] }),
            providers: { stub: { protocol: "openai-chat" as const, base_url: `http://127.0.0.1:${port}/v1`, credential: "none" as const } },
        },
    };
}

async function makeExtension(home: string): Promise<string> {
    const extension = join(home, "extension");
    await mkdir(extension);
    await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
        id: "test.wakes", sdk: "1", version: "1.0.0", entrypoint: "extension.ts",
        capabilities: ["requests.handle", "sessions.send"],
    }));
    await writeFile(join(extension, "extension.ts"), `export function activate(api) {
    api.requests.handle("send", (value) => api.sessions.send(value.id, "The map is aboard."));
}`);
    return extension;
}

async function makeWatchExtension(home: string, address: string): Promise<string> {
    const extension = join(home, "watch-extension");
    await mkdir(extension);
    await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
        id: "test.watches", sdk: "1", version: "1.0.0", entrypoint: "extension.ts", capabilities: [],
        contributes: { watches: [{ id: "main", source_family: "arc", address }] },
    }));
    await writeFile(join(extension, "extension.ts"), "export function activate() {}\n");
    return extension;
}

async function dueSchedule(socket: string, home: string, id: string): Promise<void> {
    const later = new Date(Date.now() + 12 * 60 * 60 * 1_000);
    await runScheduleOperationThroughHost(socket, {
        action: "add", id: "wake", cron: `${later.getUTCMinutes()} ${later.getUTCHours()} * * *`,
        timezone: "UTC", address: id, payload: { text: "Check the map." },
    });
    const database = new Database(defaultSchedulePath(home));
    try {
        database.query("UPDATE schedules SET next_run_at = ? WHERE id = ?")
            .run(new Date(Date.now() + 300).toISOString(), "wake");
    } finally {
        database.close();
    }
    await runScheduleOperationThroughHost(socket, { action: "show", id: "wake" });
}

function inboxState(home: string, id: string): { offset: number | null; unread: number } {
    const inbox = Inbox.open(defaultInboxPath(home));
    try {
        const consumer = { nodeId: hostname(), label: id };
        return { offset: inbox.offsetOf(consumer), unread: inbox.unreadStats(consumer, { limit: 10, addresses: [id] }).count };
    } finally {
        inbox.close();
    }
}

async function assertOnlyOwner(probe: PoolProbe, id: string, owner: number): Promise<void> {
    const residents = await Promise.all([0, 1, 2].map((index) => probe.peers.get(index)!.request("session.resident", [id])));
    expect(residents.filter((value) => value !== undefined)).toHaveLength(1);
    expect(residents[owner]).toMatchObject({ id });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
    const deadline = Date.now() + 12_000;
    while (!await predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await Bun.sleep(20);
    }
}

async function waitForTurn(client: AttachedAgentClient): Promise<void> {
    while ((await client.receive(AbortSignal.timeout(12_000))).type !== "turn_finished") {}
}

async function releaseScan(path: string): Promise<void> {
    await waitFor(() => {
        try {
            const fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
            closeSync(fd);
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENXIO") return false;
            throw error;
        }
    }, "worker scanning session files");
}

async function closePool(host: ResidentHost | undefined, probe: PoolProbe, home: string): Promise<void> {
    const annexPid = host?.annexPid;
    await host?.close();
    probe.restore();
    try {
        for (const pid of probe.allPids) expect(() => process.kill(pid, 0)).toThrow();
        if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
    } finally {
        await rm(home, { recursive: true, force: true });
    }
}

test("a due schedule wakes and is acknowledged by its nonzero worker once", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h7-multi-schedule-");
    const stub = startScheduleWakeProvider(true);
    const probe = probePool();
    let host: ResidentHost | undefined;
    let client: AttachedAgentClient | undefined;
    try {
        host = await startResidentHost(poolOptions(home, stub.port));
        const socket = host.server.socketPath;
        await createAgentThroughHost(socket, home);
        const target = await createAgentThroughHost(socket, home);
        expect(target.location?.worker_id).toBe("w1");
        expect((await requestHostIdentity(target.location!.socket_path))?.pid).toBe(probe.pids.get(1));
        expect(probe.pids.get(1)).not.toBe(process.pid);
        await assertOnlyOwner(probe, target.id, 1);
        client = await attachAgent({ socketPath: target.location!.socket_path, agentId: target.id });
        expect((await client.receive()).type).toBe("history");
        await dueSchedule(socket, home, target.id);
        await waitForTurn(client);
        expect(await runScheduleOperationThroughHost(socket, { action: "show", id: "wake" })).toMatchObject({ run_count: 1 });
        expect(inboxState(home, target.id)).toEqual({ offset: 1, unread: 0 });
        expect(stub.requests).toBe(2);
        expect(host.registry.agents.size).toBe(0);
        await client.detach();
        client.close();
        client = await attachAgent({ socketPath: target.location!.socket_path, agentId: target.id });
        expect((await client.receive()).type).toBe("history");
        expect(await Promise.race([waitForTurn(client).then(() => true), Bun.sleep(1_500).then(() => false)])).toBe(false);
        expect(stub.requests).toBe(2);
    } finally {
        client?.close();
        stub.close();
        await closePool(host, probe, home);
    }
}, 45_000);

test("an inbox entry is delivered only on w2", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h7-multi-inbox-");
    const stub = startScheduleWakeProvider(true);
    const probe = probePool();
    let host: ResidentHost | undefined;
    let client: AttachedAgentClient | undefined;
    try {
        const extension = await makeExtension(home);
        host = await startResidentHost(poolOptions(home, stub.port, extension));
        const socket = host.server.socketPath;
        await createAgentThroughHost(socket, home);
        await createAgentThroughHost(socket, home);
        const target = await createAgentThroughHost(socket, home);
        expect(target.location?.worker_id).toBe("w2");
        expect((await requestHostIdentity(target.location!.socket_path))?.pid).toBe(probe.pids.get(2));
        await assertOnlyOwner(probe, target.id, 2);
        client = await attachAgent({ socketPath: target.location!.socket_path, agentId: target.id });
        expect((await client.receive()).type).toBe("history");
        expect(await host.extensions.handleRequest("test.wakes", "send", { id: target.id }, new AbortController().signal)).toBe("queued");
        await waitForTurn(client);
        expect(inboxState(home, target.id)).toEqual({ offset: 1, unread: 0 });
        expect(stub.requests).toBe(2);
        expect(host.registry.agents.size).toBe(0);
        await assertOnlyOwner(probe, target.id, 2);
    } finally {
        client?.close();
        stub.close();
        await closePool(host, probe, home);
    }
}, 45_000);

test("a due startup schedule waits while its hash worker scans", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h7-multi-start-");
    const stub = startScheduleWakeProvider(true);
    const probe = probePool();
    let host: ResidentHost | undefined;
    let starting: Promise<ResidentHost> | undefined;
    let client: AttachedAgentClient | undefined;
    let scanPath: string | undefined;
    let scanReleased = false;
    try {
        let suffix = 0;
        while (sessionShardIndex(`startup-crow-${suffix}`, 3) !== 2) suffix += 1;
        const id = `startup-crow-${suffix}`;
        const path = join(defaultSessionDirectory(home), `${id}.jsonl`);
        await SessionStore.create(path, { sessionId: id, cwd: home });
        let blocker = 0;
        while (sessionShardIndex(`a-scan-${blocker}`, 3) !== 2) blocker += 1;
        scanPath = join(defaultSessionDirectory(home), `a-scan-${blocker}.jsonl`);
        expect(Bun.spawnSync(["/usr/bin/mkfifo", scanPath]).exitCode).toBe(0);
        const schedules = ScheduleStore.open(defaultSchedulePath(home));
        const now = new Date();
        const later = new Date(now.getTime() + 12 * 60 * 60 * 1_000);
        schedules.create({ id: "wake", cron: `${later.getUTCMinutes()} ${later.getUTCHours()} * * *`, timezone: "UTC",
            address: id, payload: JSON.stringify({ text: "Check the map." }),
            nextRunAt: new Date(now.getTime() - 1_000).toISOString(), now: now.toISOString() });
        schedules.close();
        starting = startResidentHost(poolOptions(home, stub.port));
        await waitFor(() => probe.ready.has(0) && probe.ready.has(1) && probe.peers.has(2), "other workers ready");
        expect(probe.ready.has(2)).toBe(false);
        expect(await Promise.race([starting.then(() => true), Bun.sleep(200).then(() => false)])).toBe(false);
        expect(stub.requests).toBe(0);
        await releaseScan(scanPath);
        scanReleased = true;
        host = await starting;
        await waitFor(() => inboxState(home, id).unread === 1, "held startup entry");
        expect(inboxState(home, id)).toEqual({ offset: 0, unread: 1 });
        expect(stub.requests).toBe(0);
        const target = await resumeAgentThroughHost(host.server.socketPath, path);
        expect(target.location?.worker_id).toBe("w2");
        expect((await requestHostIdentity(target.location!.socket_path))?.pid).toBe(probe.pids.get(2));
        await assertOnlyOwner(probe, id, 2);
        client = await attachAgent({ socketPath: target.location!.socket_path, agentId: id });
        expect((await client.receive()).type).toBe("history");
        await waitForTurn(client);
        expect(inboxState(home, id)).toEqual({ offset: 1, unread: 0 });
        expect((await runScheduleOperationThroughHost(host.server.socketPath, { action: "show", id: "wake" })).run_count).toBe(1);
        expect(stub.requests).toBe(2);
    } finally {
        if (!scanReleased && scanPath !== undefined && probe.peers.has(2)) await releaseScan(scanPath).catch(() => {});
        if (host === undefined && starting !== undefined) host = await starting.catch(() => undefined);
        client?.close();
        stub.close();
        await closePool(host, probe, home);
    }
}, 45_000);

test("a watch admission waits for the scanning hash owner to register its consumer", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h7-multi-scan-watch-");
    const stub = startScheduleWakeProvider(true);
    const probe = probePool();
    const watching = Promise.withResolvers<WatchRuntimeContext>();
    let host: ResidentHost | undefined;
    let starting: Promise<ResidentHost> | undefined;
    let admission: Promise<void> | undefined;
    let client: AttachedAgentClient | undefined;
    let scanPath: string | undefined;
    let scanReleased = false;
    try {
        let suffix = 0;
        while (sessionShardIndex(`saved-crow-${suffix}`, 3) !== 2) suffix += 1;
        const id = `saved-crow-${suffix}`;
        const path = join(defaultSessionDirectory(home), `${id}.jsonl`);
        await SessionStore.create(path, { sessionId: id, cwd: home });
        let blocker = 0;
        while (sessionShardIndex(`a-scan-${blocker}`, 3) !== 2) blocker += 1;
        scanPath = join(defaultSessionDirectory(home), `a-scan-${blocker}.jsonl`);
        expect(Bun.spawnSync(["/usr/bin/mkfifo", scanPath]).exitCode).toBe(0);
        const extension = await makeWatchExtension(home, id);
        starting = startResidentHost({
            ...poolOptions(home, stub.port, extension),
            watchConnectors: [{
                sourceFamily: "arc",
                run: (context) => {
                    watching.resolve(context);
                    return new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
                },
            }],
        });
        const context = await watching.promise;
        await waitFor(() => probe.ready.has(0) && probe.ready.has(1) && probe.peers.has(2), "other workers ready");
        expect(probe.ready.has(2)).toBe(false);
        admission = context.admit([{
            id: "arc:scanning", kind: "arc.post", ts: new Date().toISOString(), actor: "lookout",
            session: null, payload: { text: "A map arrived." },
        }]);
        expect(await Promise.race([admission.then(() => true), Bun.sleep(200).then(() => false)])).toBe(false);
        const before = Inbox.open(defaultInboxPath(home));
        try { expect(before.tail()).toBe(0); } finally { before.close(); }
        await releaseScan(scanPath);
        scanReleased = true;
        await admission;
        host = await starting;
        expect(inboxState(home, id)).toEqual({ offset: 0, unread: 1 });
        expect(stub.requests).toBe(0);
        const target = await resumeAgentThroughHost(host.server.socketPath, path);
        expect(target.location?.worker_id).toBe("w2");
        expect((await requestHostIdentity(target.location!.socket_path))?.pid).toBe(probe.pids.get(2));
        client = await attachAgent({ socketPath: target.location!.socket_path, agentId: id });
        expect((await client.receive()).type).toBe("history");
        await waitForTurn(client);
        expect(inboxState(home, id)).toEqual({ offset: 1, unread: 0 });
        expect(stub.requests).toBe(2);
    } finally {
        if (!scanReleased && scanPath !== undefined && probe.peers.has(2)) await releaseScan(scanPath).catch(() => {});
        await admission?.catch(() => {});
        if (host === undefined && starting !== undefined) host = await starting.catch(() => undefined);
        client?.close();
        stub.close();
        await closePool(host, probe, home);
    }
}, 45_000);

test("an entry for a stored session stays unread while its hash worker is gone", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h7-multi-offline-");
    const stub = startScheduleWakeProvider(true);
    const release = Promise.withResolvers<void>();
    const probe = probePool(async (index, generation) => {
        if (index === 2 && generation > 1) await release.promise;
    });
    const watching = Promise.withResolvers<WatchRuntimeContext>();
    let host: ResidentHost | undefined;
    let client: AttachedAgentClient | undefined;
    try {
        let suffix = 0;
        while (sessionShardIndex(`offline-crow-${suffix}`, 3) !== 2) suffix += 1;
        const id = `offline-crow-${suffix}`;
        const path = join(defaultSessionDirectory(home), `${id}.jsonl`);
        await SessionStore.create(path, { sessionId: id, cwd: home });
        const extension = await makeWatchExtension(home, id);
        const options = {
            ...poolOptions(home, stub.port, extension),
            watchConnectors: [{
                sourceFamily: "arc",
                run: (context: WatchRuntimeContext) => {
                    watching.resolve(context);
                    return new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
                },
            }],
        };
        host = await startResidentHost(options);
        const socket = host.server.socketPath;
        const lost = probe.pids.get(2)!;
        probe.peers.get(2)!.close();
        await waitFor(async () => (await requestHostIdentity(socket))?.workers_ready === 2, "worker link loss");
        await waitFor(() => { try { process.kill(lost, 0); return false; } catch { return true; } }, "worker exit");
        const context = await watching.promise;
        await context.admit([{
            id: "arc:offline", kind: "arc.post", ts: new Date().toISOString(), actor: "lookout",
            session: null, payload: { text: "A map arrived." },
        }]);
        expect(inboxState(home, id)).toEqual({ offset: 0, unread: 1 });
        expect(stub.requests).toBe(0);
        for (const index of [0, 1]) expect(await probe.peers.get(index)!.request("session.resident", [id])).toBeUndefined();
        const unavailable = await resumeAgentThroughHost(socket, path).then(() => undefined, (error: unknown) => error);
        expect(unavailable).toMatchObject({ name: "AgentStartError", message: "The session worker is unavailable." });
        release.resolve();
        await waitFor(async () => (await requestHostIdentity(socket))?.workers_ready === 3, "replacement ready");
        const target = await resumeAgentThroughHost(host.server.socketPath, path);
        expect(target.location?.worker_id).toBe("w2");
        expect((await requestHostIdentity(target.location!.socket_path))?.pid).toBe(probe.pids.get(2));
        client = await attachAgent({ socketPath: target.location!.socket_path, agentId: id });
        expect((await client.receive()).type).toBe("history");
        await waitForTurn(client);
        expect(inboxState(home, id)).toEqual({ offset: 1, unread: 0 });
        expect(stub.requests).toBe(2);
    } finally {
        release.resolve();
        client?.close();
        stub.close();
        await closePool(host, probe, home);
    }
}, 60_000);

test("a dropped worker releases its claim after exit and the held entry follows the reopened session", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h7-multi-drop-");
    const stub = startScheduleWakeProvider(true);
    const probe = probePool();
    const claims = new Map<string, MasterInboxBridge>();
    const closed = new Set<MasterInboxBridge>();
    const handle = MasterInboxBridge.prototype.handle;
    const close = MasterInboxBridge.prototype.close;
    const handleSpy = spyOn(MasterInboxBridge.prototype, "handle").mockImplementation(async function (
        this: MasterInboxBridge, method: string, args: readonly unknown[], signal?: AbortSignal,
    ) {
        const result = await handle.call(this, method, args, signal);
        const registration = args[1] as { label?: unknown } | undefined;
        if (method === "attach" && typeof registration?.label === "string") claims.set(registration.label, this);
        return result;
    });
    const closeSpy = spyOn(MasterInboxBridge.prototype, "close").mockImplementation(function (this: MasterInboxBridge) {
        close.call(this);
        closed.add(this);
    });
    let host: ResidentHost | undefined;
    let client: AttachedAgentClient | undefined;
    let paused: number | undefined;
    try {
        host = await startResidentHost(poolOptions(home, stub.port));
        const socket = host.server.socketPath;
        let target: Awaited<ReturnType<typeof createAgentThroughHost>> | undefined;
        for (let attempt = 0; attempt < 30; attempt += 1) {
            const candidate = await createAgentThroughHost(socket, home);
            if (candidate.location?.worker_id === "w2" && sessionShardIndex(candidate.id, 3) !== 2) {
                target = candidate;
                break;
            }
        }
        if (target === undefined) throw new Error("No cross-shard w2 session found");
        await assertOnlyOwner(probe, target.id, 2);
        await waitFor(() => claims.has(target!.id), "worker inbox claim");
        const oldClaim = claims.get(target.id)!;
        await dueSchedule(socket, home, target.id);
        await waitFor(() => inboxState(home, target!.id).unread === 1, "held schedule");
        expect(inboxState(home, target.id)).toEqual({ offset: 0, unread: 1 });
        expect(stub.requests).toBe(0);
        paused = probe.pids.get(2)!;
        process.kill(paused, "SIGSTOP");
        probe.peers.get(2)!.close();
        await waitFor(async () => (await requestHostIdentity(socket))?.workers_ready === 2, "worker link loss");
        const path = join(defaultSessionDirectory(home), `${target.id}.jsonl`);
        const unavailable = await resumeAgentThroughHost(socket, path).then(() => undefined, (error: unknown) => error);
        expect(unavailable).toMatchObject({ name: "AgentStartError", message: "The session worker is unavailable." });
        expect(inboxState(home, target.id)).toEqual({ offset: 0, unread: 1 });
        expect(closed.has(oldClaim)).toBe(false);
        process.kill(paused, "SIGCONT");
        const lost = paused;
        paused = undefined;
        await waitFor(() => { try { process.kill(lost, 0); return false; } catch { return true; } }, "worker exit");
        await waitFor(() => closed.has(oldClaim), "worker inbox claim release");
        await waitFor(async () => (await requestHostIdentity(socket))?.workers_ready === 3, "replacement ready");
        const reopened = await resumeAgentThroughHost(socket, path);
        const owner = 2;
        expect(reopened.location?.worker_id).toBe(`w${owner}`);
        expect((await requestHostIdentity(reopened.location!.socket_path))?.pid).toBe(probe.pids.get(owner));
        client = await attachAgent({ socketPath: reopened.location!.socket_path, agentId: target.id });
        expect((await client.receive()).type).toBe("history");
        await waitForTurn(client);
        expect(claims.get(target.id)).not.toBe(oldClaim);
        expect(inboxState(home, target.id)).toEqual({ offset: 1, unread: 0 });
        expect(stub.requests).toBe(2);
        expect((await runScheduleOperationThroughHost(socket, { action: "show", id: "wake" })).run_count).toBe(1);
    } finally {
        if (paused !== undefined) { try { process.kill(paused, "SIGCONT"); } catch {} }
        client?.close();
        stub.close();
        try { await closePool(host, probe, home); }
        finally { handleSpy.mockRestore(); closeSpy.mockRestore(); }
    }
}, 60_000);
