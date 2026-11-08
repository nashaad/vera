import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resumeAgentThroughHost, type ReadyAgent } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { emptyUsage } from "../../src/model/types.ts";
import { CRASH_CUT_MESSAGE, SessionStore, readSessionTurnState } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

for (const inProcessWorker of [false, true]) {
    test(`a startup repair blocks only the session being resumed (worker=${inProcessWorker})`, async () => {
        const root = await mkdtemp("/tmp/vera-dev/crash1-race.");
        const sessions = join(root, "sessions");
        const path = join(sessions, "crow.jsonl");
        const otherPath = join(sessions, "other.jsonl");
        const socketPath = join(root, "host.sock");
        const lockPath = join(root, "host.json");
        const original = SessionStore.prototype.repairCrashedTurn;
        let enter!: () => void;
        let release!: () => void;
        const entered = new Promise<void>((resolve) => { enter = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let host: ResidentHost | undefined;
        let waiting: Promise<ReadyAgent> | undefined;
        let attaching: Promise<AttachedAgentClient> | undefined;
        let client: AttachedAgentClient | undefined;
        let otherClient: AttachedAgentClient | undefined;
        try {
            await mkdir(sessions, { recursive: true });
            const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
            await store.appendMessage({ role: "user", content: [{ type: "text", text: "Inspect the map" }] });
            await store.appendMessage({
                role: "assistant", content: [{ type: "tool_call", id: "read-map", name: "read", input: { path: "map" } }],
                source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "tool_use",
            });
            const other = await SessionStore.create(otherPath, { sessionId: "other", cwd: root });
            await other.appendMessage({ role: "user", content: [{ type: "text", text: "Earlier prompt" }] });
            await writeFile(lockPath, JSON.stringify({
                schema_version: 3, pid: 424242, started_at: new Date(Date.now() - 60_000).toISOString(),
                socket_path: socketPath, build_id: "old",
            }));
            SessionStore.prototype.repairCrashedTurn = async function () {
                if (this.header.id === "crow") {
                    enter();
                    await gate;
                }
                return await original.call(this);
            };
            const starting = startResidentHost({
                home: root,
                config: { schema_version: 1, provider: "openrouter", model: "faux/test", approval_mode: "auto" },
                socketPath, lockPath, sessionDirectory: sessions, inProcessWorker,
                createAdapter: () => new FauxAdapter([{
                    role: "assistant", content: [{ type: "text", text: "x".repeat(500) }],
                    source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "stop",
                }], { chunkSize: 1, delayMs: 20 }),
            });
            try {
                await entered;
                let resumed = false;
                waiting = resumeAgentThroughHost(socketPath, path).then((agent) => {
                    resumed = true;
                    return agent;
                });
                void waiting.catch(() => {});
                attaching = attachAgent({ socketPath, agentId: "crow" });
                void attaching.catch(() => {});
                expect((await resumeAgentThroughHost(socketPath, otherPath)).id).toBe("other");
                otherClient = await attachAgent({ socketPath, agentId: "other" });
                expect((await otherClient.receive()).type).toBe("history");
                await otherClient.send({ type: "prompt", content: "Inspect the crow's deck" });
                while ((await otherClient.receive(AbortSignal.timeout(5_000))).type !== "user_prompt") {}
                expect(resumed).toBe(false);
                release();
                host = await starting;
                expect((await waiting).id).toBe("crow");
                client = await attaching;
                expect((await client.receive()).type).toBe("history");
                expect((await readSessionTurnState(path)).turnOpen).toBe(false);
                expect((await readSessionTurnState(otherPath)).turnOpen).toBe(true);
                expect((await readFile(otherPath, "utf8")).split(CRASH_CUT_MESSAGE)).toHaveLength(2);
                expect((await SessionStore.open(path)).messages().at(-1)).toMatchObject({
                    role: "tool_result", toolCallId: "read-map", isError: true,
                });
            } finally {
                release();
                host ??= await starting.catch(() => undefined);
            }
        } finally {
            SessionStore.prototype.repairCrashedTurn = original;
            client?.close();
            otherClient?.close();
            await waiting?.catch(() => {});
            await host?.close();
            await rm(root, { recursive: true, force: true });
        }
    }, 20_000);
}

test("an attachment repairs a nonstandard session on the master while the worker starts", async () => {
    const root = await mkdtemp("/tmp/vera-dev/crash1-startup.");
    const sessions = join(root, "sessions");
    const blockedPath = join(sessions, "a.jsonl");
    const targetPath = join(sessions, "other-name.jsonl");
    const socketPath = join(root, "host.sock");
    const lockPath = join(root, "host.json");
    const original = SessionStore.prototype.repairCrashedTurn;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let host: ResidentHost | undefined;
    let client: AttachedAgentClient | undefined;
    try {
        await mkdir(sessions, { recursive: true });
        const blocked = await SessionStore.create(blockedPath, { sessionId: "blocked", cwd: root });
        await blocked.appendMessage({ role: "user", content: [{ type: "text", text: "Inspect the deck" }] });
        const target = await SessionStore.create(targetPath, { sessionId: "crow", cwd: root });
        await target.appendMessage({ role: "user", content: [{ type: "text", text: "Inspect the map" }] });
        await writeFile(lockPath, JSON.stringify({
            schema_version: 3, pid: 424242, started_at: new Date(Date.now() - 60_000).toISOString(),
            socket_path: socketPath, build_id: "old",
        }));
        SessionStore.prototype.repairCrashedTurn = async function () {
            if (this.header.id === "blocked") {
                enter();
                await gate;
            }
            return await original.call(this);
        };
        const starting = startResidentHost({
            home: root,
            config: { schema_version: 1, provider: "openrouter", model: "faux/test", approval_mode: "auto" },
            socketPath, lockPath, sessionDirectory: sessions, inProcessWorker: true,
            createAdapter: () => new FauxAdapter([]),
        });
        try {
            await entered;
            client = await attachAgent({ socketPath, agentId: "crow" });
            expect((await client.receive(AbortSignal.timeout(5_000))).type).toBe("history");
            expect((await readSessionTurnState(targetPath)).turnOpen).toBe(false);
            release();
            host = await starting;
            expect(host.registry.agents.has("crow")).toBe(true);
            expect((await readFile(targetPath, "utf8")).split(CRASH_CUT_MESSAGE)).toHaveLength(2);
        } finally {
            release();
            host ??= await starting.catch(() => undefined);
        }
    } finally {
        SessionStore.prototype.repairCrashedTurn = original;
        client?.close();
        await host?.close();
        await rm(root, { recursive: true, force: true });
    }
}, 20_000);
