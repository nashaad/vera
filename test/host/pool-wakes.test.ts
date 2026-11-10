import { mkdirSync } from "node:fs";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";

import { createAgentThroughHost, resumeAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { sessionShardIndex } from "../../src/host/shard.ts";
import { defaultInboxPath, Inbox } from "../../src/store/inbox.ts";
import { defaultSessionDirectory, SessionStore } from "../../src/store/session-store.ts";
import type { WatchRuntimeContext } from "../../src/watch/source.ts";
import { startScheduleWakeProvider } from "../support/schedule-wake-provider.ts";
import { readPoolWorkerPids } from "../support/pool-worker-pids.ts";

for (const source of ["inbox", "watch"] as const) {
    test(`a ${source} entry wakes its owning worker once`, async () => {
        mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
        const home = await mkdtemp(join(tmpdir(), "vera-dev", "h7-wake-"));
        const extension = join(home, "extension");
        const stub = startScheduleWakeProvider(true);
        const watching = Promise.withResolvers<WatchRuntimeContext>();
        let watchStarts = 0;
        let watchStopped = false;
        let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
        let client: AttachedAgentClient | undefined;
        let workerPid: number | undefined;
        let workerPids: number[] = [];
        try {
            await mkdir(extension);
            await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
                id: "test.wakes", sdk: "1", version: "1.0.0", entrypoint: "extension.ts",
                capabilities: ["requests.handle", "sessions.send"],
                ...(source === "watch" ? {
                    contributes: { watches: [{ id: "main", source_family: "arc" }] },
                } : {}),
            }));
            await writeFile(join(extension, "extension.ts"), `export function activate(api) {
    api.requests.handle("send", (value) => api.sessions.send(value.id, "The map is aboard."));
}`);
            host = await startResidentHost({
                home, processWorker: true, skipStartupDiscovery: true,
                config: {
                    schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto",
                    curated_models_url: "", inbox: { admit: ["arc"] },
                    extensions: [{ path: extension, enabled: true, config: {} }],
                    providers: {
                        stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" },
                    },
                },
                ...(source === "watch" ? {
                    watchConnectors: [{
                        sourceFamily: "arc",
                        run: (context: WatchRuntimeContext) => {
                            watchStarts += 1;
                            watching.resolve(context);
                            return new Promise<void>((resolve) => context.signal.addEventListener("abort", () => {
                                watchStopped = true;
                                resolve();
                            }, { once: true }));
                        },
                    }],
                } : {}),
            });
            workerPids = await readPoolWorkerPids(home);
            const agent = await createAgentThroughHost(host.server.socketPath, home);
            expect(agent.location?.worker_id).toBe("w0");
            workerPid = (await requestHostIdentity(agent.location!.socket_path))!.pid;
            expect(workerPid).not.toBe(process.pid);
            expect(host.registry.agents.size).toBe(0);
            client = await attachAgent({ socketPath: agent.location!.socket_path, agentId: agent.id });
            expect((await client.receive()).type).toBe("history");
            if (source === "inbox") {
                expect(await host.extensions.handleRequest("test.wakes", "send", { id: agent.id }, new AbortController().signal))
                    .toBe("queued");
            } else {
                const context = await Promise.race([
                    watching.promise,
                    Bun.sleep(5_000).then(() => { throw new Error("Watch did not start"); }),
                ]);
                await context.admit([{
                    id: "arc:1", kind: "arc.post", ts: new Date().toISOString(), actor: "lookout",
                    session: null, payload: { text: "The map is aboard." },
                }]);
                expect(watchStarts).toBe(1);
            }
            await waitForTurn(client);
            const inbox = Inbox.open(defaultInboxPath(home));
            try {
                expect(inbox.entry(1)?.kind).toBe(source === "watch" ? "arc.post" : "extension_message");
                const consumer = { nodeId: hostname(), label: agent.id };
                expect(inbox.offsetOf(consumer)).toBe(1);
                expect(inbox.unreadStats(consumer, { limit: 10, addresses: [agent.id] }).count).toBe(0);
                expect(inbox.entry(2)).toBeUndefined();
            } finally {
                inbox.close();
            }
            await client.detach();
            client.close();
            client = await attachAgent({ socketPath: agent.location!.socket_path, agentId: agent.id });
            expect((await client.receive()).type).toBe("history");
            expect(await Promise.race([
                waitForTurn(client).then(() => true),
                Bun.sleep(1_500).then(() => false),
            ])).toBe(false);
            expect(stub.requests).toBe(2);
        } finally {
            client?.close();
            const annexPid = host?.annexPid;
            await host?.close();
            stub.close();
            try {
                if (source === "watch" && host !== undefined) expect(watchStopped).toBe(true);
                if (workerPid !== undefined) expect(() => process.kill(workerPid!, 0)).toThrow();
                for (const pid of workerPids) expect(() => process.kill(pid, 0)).toThrow();
                if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
            } finally {
                await rm(home, { recursive: true, force: true });
            }
        }
    }, 30_000);
}

test("a watch entry for a stored session waits until a client attaches", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "h7-held-watch-"));
    const extension = join(home, "extension");
    const stub = startScheduleWakeProvider(true);
    const watching = Promise.withResolvers<WatchRuntimeContext>();
    const id = "saved-crow";
    const sessionPath = join(defaultSessionDirectory(home), `${id}.jsonl`);
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let client: AttachedAgentClient | undefined;
    let workerPid: number | undefined;
    let workerPids: number[] = [];
    try {
        await SessionStore.create(sessionPath, { sessionId: id, cwd: home });
        await mkdir(extension);
        await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
            id: "test.watches", sdk: "1", version: "1.0.0", entrypoint: "extension.ts", capabilities: [],
            contributes: { watches: [{ id: "main", source_family: "arc", address: id }] },
        }));
        await writeFile(join(extension, "extension.ts"), "export function activate() {}\n");
        host = await startResidentHost({
            home, processWorker: true, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto",
                curated_models_url: "", inbox: { admit: ["arc"] },
                extensions: [{ path: extension, enabled: true, config: {} }],
                providers: {
                    stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" },
                },
            },
            watchConnectors: [{
                sourceFamily: "arc",
                run: (context) => {
                    watching.resolve(context);
                    return new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
                },
            }],
        });
        workerPids = await readPoolWorkerPids(home);
        const context = await watching.promise;
        await context.admit([{
            id: "arc:stored", kind: "arc.post", ts: new Date().toISOString(), actor: "lookout",
            session: null, payload: { text: "A map arrived." },
        }]);
        const consumer = { nodeId: hostname(), label: id };
        const held = Inbox.open(defaultInboxPath(home));
        try {
            expect(held.offsetOf(consumer)).toBe(0);
            expect(held.unreadStats(consumer, { limit: 10, addresses: [id] }).count).toBe(1);
        } finally {
            held.close();
        }
        expect((await listAgentsThroughHost(host.server.socketPath)).find((agent) => agent.id === id))
            .toMatchObject({ id, live: false });
        expect(stub.requests).toBe(0);
        const resumed = await resumeAgentThroughHost(host.server.socketPath, sessionPath);
        expect(resumed.location?.worker_id).toBe(`w${sessionShardIndex(id, workerPids.length)}`);
        workerPid = (await requestHostIdentity(resumed.location!.socket_path))!.pid;
        client = await attachAgent({ socketPath: resumed.location!.socket_path, agentId: id });
        expect((await client.receive()).type).toBe("history");
        await waitForTurn(client);
        const delivered = Inbox.open(defaultInboxPath(home));
        try {
            expect(delivered.offsetOf(consumer)).toBe(1);
            expect(delivered.unreadStats(consumer, { limit: 10, addresses: [id] }).count).toBe(0);
        } finally {
            delivered.close();
        }
        expect(stub.requests).toBe(2);
    } finally {
        client?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        stub.close();
        try {
            if (workerPid !== undefined) expect(() => process.kill(workerPid!, 0)).toThrow();
            for (const pid of workerPids) expect(() => process.kill(pid, 0)).toThrow();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 30_000);

async function waitForTurn(client: AttachedAgentClient): Promise<void> {
    while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
}
