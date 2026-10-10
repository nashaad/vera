import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ToolHooks } from "../../src/engine/hooks.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import type { SubagentFinishedHookPayload } from "../../src/sdk/hooks.ts";
import { startWorker } from "../../src/host/worker/handle.ts";
import { emptyUsage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const ADAPTER = fileURLToPath(
    new URL("./fixtures/worker-scripted-adapter.ts", import.meta.url),
);

const directory = mkdtempSync(join(tmpdir(), "vera-worker-hook-context-"));
const previousVeraHome = process.env.VERA_HOME;

beforeAll(() => {
    process.env.VERA_HOME = join(directory, ".vera");
});

afterAll(() => {
    if (previousVeraHome === undefined) delete process.env.VERA_HOME;
    else process.env.VERA_HOME = previousVeraHome;
    rmSync(directory, { recursive: true, force: true });
});

test("a worker loop stores pre-turn context the host's hooks return", async () => {
    const path = join(directory, "session.jsonl");
    let push: ((line: number, record: Record<string, unknown>) => void) | undefined;
    const store = await SessionStore.create(path, {
        sessionId: "lookout",
        cwd: directory,
        onRecordAppended: (line, record) => push?.(line, record),
    });
    const hooks = new ToolHooks();
    const joined: boolean[] = [];
    hooks.registerPreTurn((payload) => {
        joined.push(payload.arrivedDuringTurn);
        return {
            power: "mutate",
            context: "the crow buried it under the third palm",
            display: "Spotted: treasure under the third palm",
        };
    }, "lookout");
    const updates: AgentUpdate[] = [];
    const handle = await startWorker({
        store,
        session: {
            path,
            header: JSON.parse(readFileSync(path, "utf8").split("\n")[0] as string) as Record<string, unknown>,
            records: [],
        },
        model: "test",
        adapter: {
            module: ADAPTER,
            options: {
                script: [{
                    role: "assistant",
                    content: [{ type: "text", text: "third palm it is" }],
                    source: { provider: "faux", api: "scripted", model: "test" },
                    usage: emptyUsage(),
                    stopReason: "stop",
                }],
            },
        },
        data: { approvalMode: "full_access" },
        services: { hooks },
        onUpdate: (update) => void updates.push(update),
    });
    push = handle.server.pushRecord;
    try {
        handle.send({ type: "prompt", content: "where is the treasure?" });
        const deadline = Date.now() + 20_000;
        while (!store.activeEntries().some((entry) => entry.message.role === "assistant")) {
            if (Date.now() > deadline) throw new Error("Timed out waiting for the worker");
            await Bun.sleep(25);
        }

        expect(joined).toEqual([false]);
        expect(store.activeEntries().map((entry) => entry.message).slice(0, 2)).toEqual([
            { role: "user", content: [{ type: "text", text: "where is the treasure?" }] },
            {
                role: "user",
                internal: true,
                contextSource: "pre_turn",
                hookSource: "lookout",
                hookDisplay: "Spotted: treasure under the third palm",
                content: [{ type: "text", text: "the crow buried it under the third palm" }],
            },
        ]);
        expect(updates).toContainEqual(expect.objectContaining({
            type: "hook_context",
            phase: "pre_turn",
            source: "lookout",
            display: "Spotted: treasure under the third palm",
        }));
    } finally {
        handle.kill();
        await handle.outcome;
    }
}, 30_000);

test("a worker loop continues a turn once when the host's turn_ending hook asks", async () => {
    const path = join(directory, "turn-ending.jsonl");
    let push: ((line: number, record: Record<string, unknown>) => void) | undefined;
    const store = await SessionStore.create(path, {
        sessionId: "lookout-continue",
        cwd: directory,
        onRecordAppended: (line, record) => push?.(line, record),
    });
    const hooks = new ToolHooks();
    const replies: string[] = [];
    hooks.registerTurnEnding((payload) => {
        replies.push(payload.reply);
        return { power: "continue", context: "no map, no treasure", display: "Back to digging: no map drawn" };
    }, "lookout");
    const reply = (text: string) => ({
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    });
    const updates: AgentUpdate[] = [];
    const handle = await startWorker({
        store,
        session: {
            path,
            header: JSON.parse(readFileSync(path, "utf8").split("\n")[0] as string) as Record<string, unknown>,
            records: [],
        },
        model: "test",
        adapter: {
            module: ADAPTER,
            options: { script: [reply("done"), reply("done, map attached")] },
        },
        data: { approvalMode: "full_access" },
        services: { hooks },
        onUpdate: (update) => void updates.push(update),
    });
    push = handle.server.pushRecord;
    try {
        handle.send({ type: "prompt", content: "find the treasure" });
        const deadline = Date.now() + 20_000;
        while (!updates.some((update) => update.type === "turn_finished")) {
            if (Date.now() > deadline) throw new Error("Timed out waiting for the worker");
            await Bun.sleep(25);
        }

        expect(replies).toEqual(["done", "done, map attached"]);
        expect(store.activeEntries().map((entry) => entry.message.role)).toEqual([
            "user", "assistant", "user", "assistant",
        ]);
        expect(store.activeEntries()[2]?.message).toEqual({
            role: "user",
            internal: true,
            contextSource: "turn_ending",
            hookSource: "lookout",
            hookDisplay: "Back to digging: no map drawn",
            content: [{ type: "text", text: "no map, no treasure" }],
        });
        expect(updates.filter((update) => update.type === "turn_finished")).toHaveLength(1);
    } finally {
        handle.kill();
        await handle.outcome;
    }
}, 30_000);

test("a waiting subagent in a worker runs the host's hooks and reports back", async () => {
    const path = join(directory, "subagent.jsonl");
    let push: ((line: number, record: Record<string, unknown>) => void) | undefined;
    const store = await SessionStore.create(path, {
        sessionId: "captain",
        cwd: directory,
        onRecordAppended: (line, record) => push?.(line, record),
    });
    const hooks = new ToolHooks();
    const spawned: boolean[] = [];
    hooks.registerPreTurn((payload) => {
        spawned.push(payload.spawned);
        return { power: "observe" };
    }, "lookout");
    const finished: SubagentFinishedHookPayload[] = [];
    hooks.registerSubagentFinished((payload) => {
        finished.push(payload);
    });
    const source = { provider: "faux", api: "scripted", model: "test" };
    const handle = await startWorker({
        store,
        session: {
            path,
            header: JSON.parse(readFileSync(path, "utf8").split("\n")[0] as string) as Record<string, unknown>,
            records: [],
        },
        model: "test",
        adapter: {
            module: ADAPTER,
            options: {
                script: [
                    {
                        role: "assistant",
                        content: [{
                            type: "tool_call",
                            id: "call_scout",
                            name: "subagent",
                            input: { description: "scout the reef" },
                        }],
                        source,
                        usage: emptyUsage(),
                        stopReason: "tool_use",
                    },
                    {
                        role: "assistant",
                        content: [{ type: "text", text: "The reef hides a wreck." }],
                        source,
                        usage: emptyUsage(),
                        stopReason: "stop",
                    },
                    {
                        role: "assistant",
                        content: [{ type: "text", text: "We dive at dawn." }],
                        source,
                        usage: emptyUsage(),
                        stopReason: "stop",
                    },
                ],
            },
        },
        data: { approvalMode: "full_access" },
        state: { policy: { subagentPolicy: { assigned: [{ model: "test" }], allowSelf: true } } },
        services: { hooks },
        onUpdate: () => {},
    });
    push = handle.server.pushRecord;
    try {
        handle.send({ type: "prompt", content: "send a scout" });
        const deadline = Date.now() + 20_000;
        while (finished.length === 0 || !store.activeEntries().some((entry) =>
            entry.message.role === "assistant"
            && entry.message.content.some((block) => block.type === "text" && block.text === "We dive at dawn."))) {
            if (Date.now() > deadline) throw new Error("Timed out waiting for the worker");
            await Bun.sleep(25);
        }

        expect(spawned).toEqual([false, true]);
        expect(finished).toHaveLength(1);
        expect(finished[0]).toMatchObject({
            type: "subagent_finished",
            parentSessionId: "captain",
            workspace: directory,
            background: false,
            outcome: "completed",
            text: "The reef hides a wreck.",
        });
    } finally {
        handle.kill();
        await handle.outcome;
    }
}, 30_000);
