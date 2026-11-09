import { expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { listAgentPageThroughHost } from "../../src/host/agent-list-client.ts";
import { branchAgentThroughHost, createAgentThroughHost, resumeAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { HOST_CAPABILITY_SESSION_ROUTING } from "../../src/host/capabilities.ts";
import { connectHost } from "../../src/host/connection.ts";
import { ControlPeer } from "../../src/host/master/control.ts";
import * as remoteRouting from "../../src/host/master/remote-routing.ts";
import { HostRouter } from "../../src/host/master/router.ts";
import * as supervisor from "../../src/host/master/supervisor.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { searchSessionsThroughHost } from "../../src/host/session-search-client.ts";
import { importSessionThroughHost } from "../../src/host/session-import-client.ts";
import { sessionShardIndex } from "../../src/host/shard.ts";
import { checkpointStoresThroughHost } from "../../src/host/store-checkpoint-client.ts";
import { SessionStore } from "../../src/store/session-store.ts";

interface PoolProbe {
    readonly pids: number[];
    readonly pidsByIndex: Map<number, number>;
    readonly peers: Map<number, ControlPeer>;
    restore(): void;
}

function probePool(dropRoster = false, beforeStart?: (index: number, generation: number) => Promise<void>): PoolProbe {
    const pids: number[] = [];
    const pidsByIndex = new Map<number, number>();
    const peers = new Map<number, ControlPeer>();
    const start = supervisor.startSessionWorkerSupervisor;
    const spy = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation(async (options) => {
        await beforeStart?.(options.index ?? 0, options.generation);
        return await start({
            ...options,
            onSpawn(pid) {
                pids.push(pid);
                pidsByIndex.set(options.index ?? 0, pid);
                options.onSpawn?.(pid);
            },
            onConnected(peer) {
                peers.set(options.index ?? 0, peer);
                options.onConnected(peer);
            },
            onEvent(event, value) {
                if (!dropRoster || event !== "roster_delta") options.onEvent(event, value);
            },
        });
    });
    return { pids, pidsByIndex, peers, restore: () => spy.mockRestore() };
}

function stubProvider() {
    return Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            return new Response([
                'data: {"id":"x","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"The crow found the map."},"finish_reason":"stop"}]}',
                "", "data: [DONE]", "",
            ].join("\n"), { headers: { "content-type": "text/event-stream" } });
        },
    });
}

function poolOptions(home: string, port: number | undefined) {
    if (port === undefined) throw new Error("Stub provider did not bind");
    return {
        home, processWorker: true, processWorkerCount: 3, skipStartupDiscovery: true,
        config: {
            schema_version: 1 as const, provider: "stub", model: "stub-model", approval_mode: "auto" as const, curated_models_url: "",
            providers: { stub: { protocol: "openai-chat" as const, base_url: `http://127.0.0.1:${port}/v1`, credential: "none" as const } },
        },
    };
}

test("three workers scan thirty sessions, own each once, and search fails closed", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs6-pool-scan-");
    const directory = join(home, "runtime", "sessions");
    await mkdir(directory, { recursive: true });
    const expected = new Set<string>();
    const marked = new Set<number>();
    for (let number = 0; number < 30; number += 1) {
        const id = `crow-${number}`;
        expected.add(id);
        const store = await SessionStore.create(join(directory, `${id}.jsonl`), { sessionId: id, cwd: home });
        const owner = sessionShardIndex(id, 3);
        if (!marked.has(owner)) {
            marked.add(owner);
            await store.appendMessage({ role: "user", content: [{ type: "text", text: "pirate map aboard" }] });
        }
    }
    const stub = stubProvider();
    const release = Promise.withResolvers<void>();
    const probe = probePool(false, async (index, generation) => {
        if (index === 1 && generation > 1) await release.promise;
    });
    let host: ResidentHost | undefined;
    try {
        host = await startResidentHost(poolOptions(home, stub.port));
        const socket = host.server.socketPath;
        expect((await requestHostIdentity(socket))?.workers_ready).toBe(3);
        expect(probe.pids).toHaveLength(3);
        for (let index = 0; index < 3; index += 1) {
            const record = JSON.parse(await readFile(join(home, "runtime", "workers", `w${index}.json`), "utf8"));
            expect(record).toMatchObject({
                id: `w${index}`, index, pid: probe.pidsByIndex.get(index), master_pid: process.pid,
                socket_path: join(home, "runtime", `w${index}.sock`),
                control_path: join(home, "runtime", "control.sock"),
            });
        }
        const listed = await listAgentPageThroughHost(socket, { limit: 100 }, 10_000);
        expect(new Set(listed.agents.map((row) => row.id))).toEqual(expected);
        const found = await searchSessionsThroughHost(socket, { query: "pirate map aboard" }, 20_000);
        expect(found.results).toHaveLength(3);
        expect(new Set(found.results.map((row) => sessionShardIndex(row.session_id, 3))).size).toBe(3);
        for (const id of expected) {
            const location = await request(socket, { type: "locate_agent", agent_id: id });
            expect(location).toMatchObject({ type: "agent_location", worker_id: `w${sessionShardIndex(id, 3)}` });
            const residents = await Promise.all([0, 1, 2].map((index) =>
                probe.peers.get(index)!.request("session.resident", [id])
            ));
            expect(residents.filter((value) => value !== undefined)).toHaveLength(1);
            expect(residents[sessionShardIndex(id, 3)]).toMatchObject({ id });
        }
        const killed = probe.pidsByIndex.get(1)!;
        process.kill(killed, "SIGKILL");
        await waitForExit(killed);
        await waitFor(async () => (await requestHostIdentity(socket))?.workers_ready === 2);
        await waitFor(() => !existsSync(join(home, "runtime", "workers", "w1.json")));
        expect(await request(socket, { type: "search_sessions", query: { query: "pirate" } }))
            .toEqual({ type: "session_search_unavailable" });
        expect(await request(socket, { type: "import_session", path: join(home, "missing.jsonl") }))
            .toEqual({ type: "session_import_rejected", reason: "failed" });
        const failure = await searchSessionsThroughHost(socket, { query: "pirate" }, 10_000)
            .then(() => undefined, (error: unknown) => error);
        expect(failure).toMatchObject({ name: "SessionSearchUnavailableError" });
        let suffix = 0;
        while (sessionShardIndex(`late-${suffix}`, 3) !== 1) suffix += 1;
        const missingOwnerId = `late-${suffix}`;
        const missingOwnerPath = join(directory, `${missingOwnerId}.jsonl`);
        await SessionStore.create(missingOwnerPath, { sessionId: missingOwnerId, cwd: home });
        const unavailable = await resumeAgentThroughHost(socket, missingOwnerPath).then(() => undefined, (error: unknown) => error);
        expect(unavailable).toMatchObject({ name: "AgentStartError", message: "The session process is unavailable." });
        for (const index of [0, 2]) {
            expect(await probe.peers.get(index)!.request("session.resident", [missingOwnerId])).toBeUndefined();
        }
    } finally {
        release.resolve();
        const annexPid = host?.annexPid;
        await host?.close();
        stub.stop(true);
        probe.restore();
        try {
            for (const pid of probe.pids) expect(() => process.kill(pid, 0)).toThrow();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
            for (let index = 0; index < 3; index += 1) expect(existsSync(join(home, "runtime", "workers", `w${index}.json`))).toBe(false);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 90_000);

test("creates balance resident sessions, concurrent resumes converge, and two workers run turns", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs6-pool-turn-");
    const stub = stubProvider();
    const probe = probePool();
    let host: ResidentHost | undefined;
    const clients: AttachedAgentClient[] = [];
    try {
        host = await startResidentHost(poolOptions(home, stub.port));
        const socket = host.server.socketPath;
        const created = [];
        for (let index = 0; index < 4; index += 1) created.push(await createAgentThroughHost(socket, home));
        expect(created.map((session) => session.location?.worker_id)).toEqual(["w0", "w1", "w2", "w0"]);
        const id = "late-crow";
        const path = join(home, "runtime", "sessions", `${id}.jsonl`);
        const late = await SessionStore.create(path, { sessionId: id, cwd: home });
        await late.appendMessage({ role: "user", content: [{ type: "text", text: "late pirate chart" }] });
        expect((await searchSessionsThroughHost(socket, { query: "late pirate chart" })).results.map((row) => row.session_id)).toEqual([id]);
        const resumed = await Promise.all([resumeAgentThroughHost(socket, path), resumeAgentThroughHost(socket, path)]);
        expect(resumed.map((session) => session.location?.worker_id)).toEqual([
            `w${sessionShardIndex(id, 3)}`, `w${sessionShardIndex(id, 3)}`,
        ]);
        const residents = await Promise.all([0, 1, 2].map((index) => probe.peers.get(index)!.request("session.resident", [id])));
        expect(residents.filter((value) => value !== undefined)).toHaveLength(1);
        for (const session of created.slice(0, 2)) {
            const client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
            clients.push(client);
            expect((await client.receive()).type).toBe("history");
            await client.send({ type: "prompt", content: "Where is the map?" });
        }
        for (const client of clients) {
            let update;
            do { update = await client.receive(AbortSignal.timeout(15_000)); } while (update.type !== "turn_finished");
            expect(update.outcome).toBeUndefined();
        }
        expect(new Set((await searchSessionsThroughHost(socket, { query: "Where is the map?" })).results.map((row) => row.session_id)))
            .toEqual(new Set(created.slice(0, 2).map((session) => session.id)));
        const flushed = new Set<number>();
        const originalRequest = ControlPeer.prototype.request;
        const flushSpy = spyOn(ControlPeer.prototype, "request").mockImplementation(function <T>(
            this: ControlPeer, method: string, args: readonly unknown[] = [], signal?: AbortSignal,
        ): Promise<T> {
            if (method === "session.flush") {
                for (const [index, peer] of probe.peers) if (peer === this) flushed.add(index);
            }
            return originalRequest.call(this, method, args, signal) as Promise<T>;
        });
        try {
            await checkpointStoresThroughHost(socket, join(home, "checkpoint"));
            expect(flushed).toEqual(new Set([0, 1, 2]));
        } finally {
            flushSpy.mockRestore();
        }
    } finally {
        for (const client of clients) client.close();
        const annexPid = host?.annexPid;
        await host?.close();
        stub.stop(true);
        probe.restore();
        try {
            for (const pid of probe.pids) expect(() => process.kill(pid, 0)).toThrow();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 90_000);

test("control loss stops the child before its replacement reclaims sessions", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs6-control-loss-");
    const stub = stubProvider();
    const probe = probePool();
    let host: ResidentHost | undefined;
    let pausedPid: number | undefined;
    let exited = false;
    try {
        host = await startResidentHost(poolOptions(home, stub.port));
        const socket = host.server.socketPath;
        let session: Awaited<ReturnType<typeof createAgentThroughHost>> | undefined;
        for (let attempt = 0; attempt < 100; attempt += 1) {
            const created = await createAgentThroughHost(socket, home);
            const index = Number(created.location!.worker_id.slice(1));
            if (sessionShardIndex(created.id, 3) !== index) { session = created; break; }
        }
        if (session === undefined) throw new Error("No cross-shard session selected");
        const index = Number(session.location!.worker_id.slice(1));
        const hashIndex = sessionShardIndex(session.id, 3);
        pausedPid = probe.pidsByIndex.get(index)!;
        process.kill(pausedPid, "SIGSTOP");
        probe.peers.get(index)!.close();
        await waitFor(async () => (await requestHostIdentity(socket))?.workers_ready === 2);
        expect(() => process.kill(pausedPid!, 0)).not.toThrow();
        expect(await request(socket, { type: "locate_agent", agent_id: session.id }))
            .toMatchObject({ type: "agent_location_failed", reason: "worker_unavailable", message: "The session process is unavailable." });
        expect(await request(join(home, "runtime", `w${hashIndex}.sock`), {
            type: "attach", agent_id: session.id, requested_capabilities: [HOST_CAPABILITY_SESSION_ROUTING],
        })).toMatchObject({ type: "attach_failed", reason: "unavailable" });
        const path = join(home, "runtime", "sessions", `${session.id}.jsonl`);
        const unavailable = await resumeAgentThroughHost(socket, path).then(() => undefined, (error: unknown) => error);
        expect(unavailable).toMatchObject({ name: "AgentStartError", message: "The session process is unavailable." });
        expect(await probe.peers.get(hashIndex)!.request("session.resident", [session.id])).toBeUndefined();
        await waitForExit(pausedPid);
        exited = true;
        let resumed: Awaited<ReturnType<typeof resumeAgentThroughHost>> | undefined;
        await waitFor(async () => {
            resumed = await resumeAgentThroughHost(socket, path).catch(() => undefined);
            return resumed !== undefined;
        });
        expect(resumed?.location?.worker_id).toBe(`w${index}`);
        const residents = await Promise.all([0, 1, 2].map((worker) => probe.peers.get(worker)!.request("session.resident", [session!.id])));
        expect(residents.filter((value) => value !== undefined)).toHaveLength(1);
        expect(residents[index]).toMatchObject({ id: session.id });
    } finally {
        if (pausedPid !== undefined && !exited) {
            try { process.kill(pausedPid, "SIGCONT"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
        const annexPid = host?.annexPid;
        await host?.close();
        stub.stop(true);
        probe.restore();
        try {
            for (const pid of probe.pids) expect(() => process.kill(pid, 0)).toThrow();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 90_000);

test("a resume fails while its unindexed hash owner is still starting", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs6-owner-start-");
    const directory = join(home, "runtime", "sessions");
    await mkdir(directory, { recursive: true });
    let number = 0;
    while (sessionShardIndex(`crow-${number}`, 3) !== 1) number += 1;
    const id = `crow-${number}`;
    const path = join(directory, `${id}.jsonl`);
    await SessionStore.create(path, { sessionId: id, cwd: home });
    const release = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const stub = stubProvider();
    const probe = probePool(false, async (index) => {
        if (index !== 1) return;
        held.resolve();
        await release.promise;
    });
    let host: ResidentHost | undefined;
    let starting: Promise<ResidentHost> | undefined;
    try {
        starting = startResidentHost(poolOptions(home, stub.port));
        void starting.catch(() => {});
        await within(held.promise);
        const socket = join(home, "runtime", "host.sock");
        await waitFor(async () => (await requestHostIdentity(socket))?.workers_ready === 2);
        const unavailable = await within(resumeAgentThroughHost(socket, path).then(() => undefined, (error: unknown) => error));
        expect(unavailable).toMatchObject({ name: "AgentStartError", message: "The session process is unavailable." });
        for (const index of [0, 2]) expect(await probe.peers.get(index)!.request("session.resident", [id])).toBeUndefined();
        release.resolve();
        host = await starting;
        expect((await resumeAgentThroughHost(socket, path)).location?.worker_id).toBe("w1");
    } finally {
        release.resolve();
        host ??= await starting?.catch(() => undefined);
        const annexPid = host?.annexPid;
        await host?.close();
        stub.stop(true);
        probe.restore();
        try {
            for (const pid of probe.pids) expect(() => process.kill(pid, 0)).toThrow();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 90_000);

test("a lost create reply must not leave one session open on two workers", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs6-pool-loss-");
    const stub = stubProvider();
    const probe = probePool(true);
    const originalRequest = ControlPeer.prototype.request;
    let paused: { readonly pid: number; readonly index: number; readonly id: string; readonly path: string } | undefined;
    const requestSpy = spyOn(ControlPeer.prototype, "request").mockImplementation(function <T>(
        this: ControlPeer, method: string, args: readonly unknown[] = [], signal?: AbortSignal,
    ): Promise<T> {
        const result = originalRequest.call(this, method, args, signal);
        if (method !== "session.create") return result as Promise<T>;
        return result.then((value) => {
            const session = value as { id: string; sessionPath: string };
            const index = [...probe.peers.entries()].find(([, peer]) => peer === this)?.[0];
            if (paused === undefined && index !== undefined && sessionShardIndex(session.id, 3) !== index) {
                const pid = probe.pidsByIndex.get(index)!;
                process.kill(pid, "SIGSTOP");
                paused = { pid, index, id: session.id, path: session.sessionPath };
                this.close();
                throw new Error("control connection closed before the create reply");
            }
            return value;
        }) as Promise<T>;
    });
    let host: ResidentHost | undefined;
    let pausedExited = false;
    try {
        host = await startResidentHost(poolOptions(home, stub.port));
        const socket = host.server.socketPath;
        for (let attempt = 0; attempt < 100 && paused === undefined; attempt += 1) {
            await createAgentThroughHost(socket, home).catch(() => undefined);
        }
        const lost = paused;
        if (lost === undefined) throw new Error("No cross-shard create selected");
        await waitFor(async () => (await requestHostIdentity(socket))?.workers_ready === 2);
        expect(() => process.kill(lost.pid, 0)).not.toThrow();
        const hashIndex = sessionShardIndex(lost.id, 3);
        expect(hashIndex).not.toBe(lost.index);
        const unavailable = await resumeAgentThroughHost(socket, lost.path).then(() => undefined, (error: unknown) => error);
        expect(unavailable).toMatchObject({ name: "AgentStartError", message: "The session process is unavailable." });
        const second = await probe.peers.get(hashIndex)!.request("session.resident", [lost.id]);
        expect([true, second !== undefined].filter(Boolean)).toHaveLength(1);
        await waitForExit(lost.pid);
        pausedExited = true;
        let resumed: Awaited<ReturnType<typeof resumeAgentThroughHost>> | undefined;
        await waitFor(async () => {
            resumed = await resumeAgentThroughHost(socket, lost.path).catch(() => undefined);
            return resumed !== undefined;
        });
        expect(resumed?.location?.worker_id).toBe(`w${lost.index}`);
        const residents = await Promise.all([0, 1, 2].map((worker) => probe.peers.get(worker)!.request("session.resident", [lost.id])));
        expect(residents.filter((value) => value !== undefined)).toHaveLength(1);
        expect(residents[lost.index]).toMatchObject({ id: lost.id });
    } finally {
        if (paused !== undefined && !pausedExited) {
            try { process.kill(paused.pid, "SIGCONT"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
        const annexPid = host?.annexPid;
        await host?.close();
        requestSpy.mockRestore();
        stub.stop(true);
        probe.restore();
        try {
            for (const pid of probe.pids) expect(() => process.kill(pid, 0)).toThrow();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 90_000);

test("imports keep their assigned owner and deduplicate after the pool restarts", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs6-pool-import-");
    const source = join(home, "source.jsonl");
    const stub = stubProvider();
    const probe = probePool();
    const annexPids: number[] = [];
    let host: ResidentHost | undefined;
    try {
        host = await startResidentHost(poolOptions(home, stub.port));
        if (host.annexPid !== undefined) annexPids.push(host.annexPid);
        let imported: Awaited<ReturnType<typeof importSessionThroughHost>> | undefined;
        for (let attempt = 0; attempt < 100; attempt += 1) {
            await writeFile(source, [
                { sessionId: `source-${attempt}`, cwd: home, isSidechain: false, type: "user", uuid: "u1", parentUuid: null,
                    timestamp: "2026-11-01T10:00:00.000Z", message: { role: "user", content: "Find the map." } },
                { sessionId: `source-${attempt}`, cwd: home, isSidechain: false, type: "assistant", uuid: "a1", parentUuid: "u1",
                    timestamp: "2026-11-01T10:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "Found it." }] } },
            ].map((row) => JSON.stringify(row)).join("\n") + "\n");
            const result = await importSessionThroughHost(host.server.socketPath, source);
            if (result.status !== "imported") throw new Error(result.reason);
            if (sessionShardIndex(result.sessionId, 3) !== 0) { imported = result; break; }
        }
        if (imported?.status !== "imported") throw new Error("No imported session selected");
        expect((await resumeAgentThroughHost(host.server.socketPath, imported.sessionPath)).location?.worker_id).toBe("w0");
        expect(await importSessionThroughHost(host.server.socketPath, source)).toEqual({ ...imported, existing: true });
        await host.close();
        host = await startResidentHost(poolOptions(home, stub.port));
        if (host.annexPid !== undefined) annexPids.push(host.annexPid);
        expect((await resumeAgentThroughHost(host.server.socketPath, imported.sessionPath)).location?.worker_id)
            .toBe(`w${sessionShardIndex(imported.sessionId, 3)}`);
        expect(await importSessionThroughHost(host.server.socketPath, source)).toEqual({ ...imported, existing: true });
        const residents = await Promise.all([0, 1, 2].map((index) =>
            probe.peers.get(index)!.request("session.resident", [imported!.sessionId])
        ));
        expect(residents.filter((value) => value !== undefined)).toHaveLength(1);
    } finally {
        await host?.close();
        stub.stop(true);
        probe.restore();
        try {
            for (const pid of [...probe.pids, ...annexPids]) expect(() => process.kill(pid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 90_000);

test("a branch being published cannot be resumed on its hash owner", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs6-pool-branch-");
    const stub = stubProvider();
    const probe = probePool();
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const selected = Promise.withResolvers<string>();
    const resumeEntered = Promise.withResolvers<void>();
    let target: string | undefined;
    const originalServe = remoteRouting.serveRoutedMethod;
    const routingSpy = spyOn(remoteRouting, "serveRoutedMethod").mockImplementation(async (router, kind, method, args, signal) => {
        if (kind === "router" && method === "beginWorkerCreate" && args[0] === "w0" && typeof args[1] === "string") {
            const result = await originalServe(router, kind, method, args, signal);
            if (target === undefined && sessionShardIndex(args[1], 3) !== 0) {
                target = args[1];
                selected.resolve(target);
            }
            return result;
        }
        if (kind === "router" && method === "endWorkerOpen" && args[0] === target) {
            held.resolve();
            await release.promise;
        }
        return await originalServe(router, kind, method, args, signal);
    });
    const originalInspect = HostRouter.prototype.inspectForResume;
    const resumeSpy = spyOn(HostRouter.prototype, "inspectForResume").mockImplementation(function (this: HostRouter, path) {
        const result = originalInspect.call(this, path);
        if (target !== undefined && path.endsWith(`/${target}.jsonl`)) resumeEntered.resolve();
        return result;
    });
    let host: ResidentHost | undefined;
    let branch: Promise<Awaited<ReturnType<typeof branchAgentThroughHost>>> | undefined;
    let resume: Promise<Awaited<ReturnType<typeof resumeAgentThroughHost>>> | undefined;
    try {
        host = await startResidentHost(poolOptions(home, stub.port));
        const source = await createAgentThroughHost(host.server.socketPath, home);
        expect(source.location?.worker_id).toBe("w0");
        for (let attempt = 0; attempt < 100 && target === undefined; attempt += 1) {
            branch = branchAgentThroughHost(source.location!.socket_path, source.id, "at");
            void branch.catch(() => {});
            await Promise.race([selected.promise, branch]);
        }
        const targetId = target;
        if (targetId === undefined) throw new Error("No cross-shard branch selected");
        await within(held.promise);
        const path = join(home, "runtime", "sessions", `${targetId}.jsonl`);
        resume = resumeAgentThroughHost(host.server.socketPath, path);
        void resume.catch(() => {});
        await within(resumeEntered.promise);
        const residents = await Promise.all([0, 1, 2].map((index) => probe.peers.get(index)!.request("session.resident", [targetId])));
        expect(residents.filter((value) => value !== undefined)).toHaveLength(1);
        expect(residents[0]).toMatchObject({ id: targetId });
        release.resolve();
        expect((await within(branch!)).id).toBe(targetId);
        expect((await within(resume)).location?.worker_id).toBe("w0");
    } finally {
        release.resolve();
        await branch?.catch(() => {});
        await resume?.catch(() => {});
        const annexPid = host?.annexPid;
        await host?.close();
        routingSpy.mockRestore();
        resumeSpy.mockRestore();
        stub.stop(true);
        probe.restore();
        try {
            for (const pid of probe.pids) expect(() => process.kill(pid, 0)).toThrow();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 90_000);

async function request(socketPath: string, message: object): Promise<unknown> {
    const connection = await connectHost({ socketPath });
    try {
        await connection.send(message);
        return await connection.receiveWithin(15_000, "Timed out waiting for the host");
    } finally {
        connection.close();
    }
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 8_000;
    while (!await predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for pool state");
        await Bun.sleep(10);
    }
}

async function waitForExit(pid: number): Promise<void> {
    await waitFor(() => {
        try { process.kill(pid, 0); return false; } catch { return true; }
    });
}

async function within<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("Timed out waiting for pool")), 15_000);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
