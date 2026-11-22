import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { HostRouter, type SessionEndpoint } from "../../src/host/pool/router.ts";
import { pruneScratch } from "../../src/host/scratch-retention.ts";
import { sessionEndpoint } from "../../src/host/session-host/endpoint.ts";
import type { SessionHost } from "../../src/host/session-host/types.ts";
import { sessionScratchDir } from "../../src/session-scratch.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

function endpoint(residents: () => Promise<readonly { id: string; workspace: string; sessionPath: string }[]>): SessionEndpoint {
    return {
        residents,
        canonicalPath: async (path: string) => path,
    } as unknown as SessionEndpoint;
}

test("@core scratch deletion is refused while a routed host open is pending", async () => {
    const host = endpoint(async () => []);
    const worker = endpoint(async () => []);
    const router = new HostRouter({
        host,
        worker,
        hostSocket: "/host.sock",
        workerSocket: "/worker.sock",
        buildId: "test",
    });
    const id = "session-id";
    await router.beginHostCreate(id, `/sessions/${id}.jsonl`);
    let removed = false;
    const detach = async (stillUnowned: () => boolean) => {
        if (!stillUnowned()) return false;
        removed = true;
        return true;
    };
    expect(await router.removeScratchIfUnowned(id, detach)).toBe(false);
    expect(removed).toBe(false);
    router.endHostOpen(id);
    expect(await router.removeScratchIfUnowned(id, detach)).toBe(true);
    expect(removed).toBe(true);
});

test("@core scratch deletion retains live host and worker sessions", async () => {
    const resident = (id: string) => ({ id, workspace: "/work", sessionPath: `/sessions/${id}.jsonl` });
    const host = endpoint(async () => [resident("host-live")]);
    const worker = endpoint(async () => [resident("worker-live")]);
    const router = new HostRouter({
        host,
        worker,
        hostSocket: "/host.sock",
        workerSocket: "/worker.sock",
        buildId: "test",
    });
    const removed: string[] = [];
    expect(await router.removeScratchIfUnowned("host-live", async () => { removed.push("host-live"); return true; })).toBe(false);
    expect(await router.removeScratchIfUnowned("worker-live", async () => { removed.push("worker-live"); return true; })).toBe(false);
    expect(removed).toEqual([]);
});

test("@core the sweep keeps an old scratch directory owned by a real resident", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-scratch-resident-"));
    const sessions = join(home, "runtime", "sessions");
    const registry = new AgentRegistry({
        home,
        createAdapter: () => new FauxAdapter([]),
        model: "faux/test",
        approvalMode: "auto",
        sessionPathForId: (id) => join(sessions, `${id}.jsonl`),
    });
    try {
        await registry.create({ id: "live", workspace: home });
        const entry = registry.agents.get("live");
        if (entry === undefined) throw new Error("Resident session is unavailable");
        await entry.store.materialize();
        const old = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
        utimesSync(entry.store.path, old, old);
        const scratch = sessionScratchDir("live", home);
        const router = new HostRouter({
            host: sessionEndpoint({ registry } as SessionHost),
            worker: endpoint(async () => []),
            hostSocket: "/host.sock",
            workerSocket: "/worker.sock",
            buildId: "test",
        });
        const result = await pruneScratch(join(home, "runtime", "scratch"), sessions, {
            removeIfUnowned: (id, remove) => router.removeScratchIfUnowned(id, remove),
        });
        expect(result.removedDirectories).toBe(0);
        expect(existsSync(scratch)).toBe(true);
    } finally {
        await registry.close();
        rmSync(home, { recursive: true, force: true });
    }
});

test("@core scratch deletion rechecks worker readiness after querying residents", async () => {
    let ready = true;
    let removed = false;
    const router = new HostRouter({
        host: endpoint(async () => []),
        worker: endpoint(async () => {
            ready = false;
            return [];
        }),
        hostSocket: "/host.sock",
        workerSocket: "/worker.sock",
        buildId: "test",
        workerReady: () => ready,
    });
    expect(await router.removeScratchIfUnowned("session-id", async () => { removed = true; return true; })).toBe(false);
    expect(removed).toBe(false);
});

test("@core scratch detachment rechecks worker readiness after asynchronous inspection", async () => {
    let ready = true;
    let removed = false;
    const router = new HostRouter({
        host: endpoint(async () => []),
        worker: endpoint(async () => []),
        hostSocket: "/host.sock",
        workerSocket: "/worker.sock",
        buildId: "test",
        workerReady: () => ready,
    });
    const result = await router.removeScratchIfUnowned("session-id", async (stillUnowned) => {
        await Promise.resolve();
        ready = false;
        if (!stillUnowned()) return false;
        removed = true;
        return true;
    });
    expect(result).toBe(false);
    expect(removed).toBe(false);
});

test("@core a routed session open waits for guarded scratch detachment", async () => {
    const router = new HostRouter({
        host: endpoint(async () => []),
        worker: endpoint(async () => []),
        hostSocket: "/host.sock",
        workerSocket: "/worker.sock",
        buildId: "test",
    });
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let opened = false;
    const detach = router.removeScratchIfUnowned("session-id", async (stillUnowned) => {
        entered.resolve();
        await finish.promise;
        return stillUnowned();
    });
    await entered.promise;
    const open = router.beginHostCreate("session-id").then(() => { opened = true; });
    await Promise.resolve();
    expect(opened).toBe(false);
    finish.resolve();
    expect(await detach).toBe(true);
    await open;
    expect(opened).toBe(true);
    router.endHostOpen("session-id");
});

test("@core scratch deletion fails safe when ownership is uncertain or a worker is unavailable", async () => {
    const host = endpoint(async () => []);
    const worker = endpoint(async () => []);
    let uncertain = true;
    let ready = true;
    const router = new HostRouter({
        host,
        worker,
        hostSocket: "/host.sock",
        workerSocket: "/worker.sock",
        buildId: "test",
        ownershipUncertain: () => uncertain,
        workerReady: () => ready,
    });
    const remove = async () => true;
    expect(await router.removeScratchIfUnowned("session-id", remove)).toBe(false);
    uncertain = false;
    ready = false;
    expect(await router.removeScratchIfUnowned("session-id", remove)).toBe(false);
});
