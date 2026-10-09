import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ToolHooks } from "../../src/engine/hooks.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
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
        return { power: "mutate", context: "the crow buried it under the third palm" };
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
                content: [{ type: "text", text: "the crow buried it under the third palm" }],
            },
        ]);
        expect(updates).toContainEqual(expect.objectContaining({
            type: "hook_context",
            phase: "pre_turn",
            source: "lookout",
        }));
    } finally {
        handle.kill();
        await handle.outcome;
    }
}, 30_000);
