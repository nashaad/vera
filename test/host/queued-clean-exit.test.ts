import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import { recoverCrashedTurns } from "../../src/host/restart-scan.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { CRASH_CUT_MESSAGE, SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const response: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Ready." }],
    source: { provider: "faux", api: "scripted", model: "test" },
    usage: emptyUsage(),
    stopReason: "stop",
};

for (const worker of [false, true]) {
    for (const exit of ["host stop", "session close"] as const) {
        test(`${worker ? "worker" : "in-process"} ${exit} clears held prompts after abort`, async () => {
            const root = await mkdtemp(join(tmpdir(), "vera-queue-clean-exit-"));
            const sessions = join(root, "sessions");
            const path = join(sessions, "crow.jsonl");
            const lockPath = join(root, "host.json");
            await mkdir(sessions);
            const registry = new AgentRegistry({
                model: "faux/test",
                approvalMode: "auto",
                createAdapter: () => new FauxAdapter([response], { delayMs: 1_000 }),
                ...(worker ? {
                    workerAdapterSpec: () => ({
                        module: join(import.meta.dir, "fixtures/worker-scripted-adapter.ts"),
                        options: { script: [response], delayMs: 1_000 },
                    }),
                } : {}),
            });
            let closed = false;
            try {
                const agent = await registry.create({ id: "crow", workspace: root, sessionPath: path });
                const client = agent.attach();
                await receiveType(client, "history");
                client.send({ type: "prompt", content: "first" });
                await receiveType(client, "user_prompt");
                client.send({ type: "prompt", content: "held" });
                const queued = await receiveType(client, "prompt_queue");
                expect(queued.queue.prompts.map((prompt) => prompt.content)).toEqual(["held"]);
                expect((await SessionStore.open(path)).queuedPrompts()).toHaveLength(1);
                client.send({ type: "abort" });
                await receiveType(client, "turn_finished");
                expect((await SessionStore.open(path)).queuedPrompts()).toHaveLength(1);
                client.detach();
                if (exit === "session close") {
                    expect(await registry.closeAgent("crow")).toBe("closed");
                } else {
                    await registry.close();
                    closed = true;
                }

                const reopened = await SessionStore.open(path);
                expect(reopened.queuedPrompts()).toEqual([]);
                expect(await reopened.repairCrashedTurn()).toBe(false);
                expect(reopened.unsentPrompts()).toEqual([]);
                expect(await readFile(path, "utf8")).not.toContain(CRASH_CUT_MESSAGE);
                await writeFile(lockPath, JSON.stringify({
                    schema_version: 3, pid: 424242, started_at: new Date(Date.now() - 60_000).toISOString(),
                    socket_path: join(root, "host.sock"), build_id: "test",
                }));
                const scan = await recoverCrashedTurns({
                    lockPath, sessionDirectory: sessions, recordPath: join(root, "restarts.jsonl"),
                    isProcessAlive: () => false,
                });
                expect(scan.recorded).toEqual([]);
            } finally {
                if (!closed) await registry.close();
                await rm(root, { recursive: true, force: true });
            }
        }, 20_000);
    }
}

test("a turn that throws clears its held prompts before the session fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-queue-turn-error-"));
    const path = join(root, "crow.jsonl");
    const gate = Promise.withResolvers<void>();
    const registry = new AgentRegistry({
        model: "faux/test",
        approvalMode: "auto",
        createAdapter: () => ({
            stream: () => ({
                async *[Symbol.asyncIterator]() {
                    await gate.promise;
                    throw new Error("stream stopped");
                },
                async result(): Promise<AssistantMessage> {
                    throw new Error("stream stopped");
                },
            }),
        }),
    });
    try {
        const agent = await registry.create({ id: "crow", workspace: root, sessionPath: path });
        const client = agent.attach();
        await receiveType(client, "history");
        client.send({ type: "prompt", content: "first" });
        await receiveType(client, "user_prompt");
        client.send({ type: "prompt", content: "held" });
        await receiveType(client, "prompt_queue");
        expect((await SessionStore.open(path)).queuedPrompts()).toHaveLength(1);
        gate.resolve();
        await receiveType(client, "agent_failed");
        const reopened = await SessionStore.open(path);
        expect(reopened.queuedPrompts()).toEqual([]);
        expect(reopened.unsentPrompts()).toEqual([]);
        expect(await readFile(path, "utf8")).not.toContain(CRASH_CUT_MESSAGE);
        client.detach();
    } finally {
        gate.resolve();
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
}, 20_000);

async function receiveType<T extends AgentUpdate["type"]>(
    client: AgentAttachment,
    type: T,
): Promise<Extract<AgentUpdate, { readonly type: T }>> {
    const signal = AbortSignal.timeout(10_000);
    while (true) {
        const update = await client.receive(signal);
        if (update.type === type) return update as Extract<AgentUpdate, { readonly type: T }>;
    }
}
