import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { projectTranscript } from "../../src/engine/protocol.ts";
import { emptyUsage } from "../../src/model/types.ts";
import { prepareWorkerExit } from "../../src/host/pool/worker-exit.ts";
import { readSessionTurnState, SessionStore, WORKER_EXIT_TURN_MESSAGE } from "../../src/store/session-store.ts";

test("worker recovery records one failed turn and preserves unsent prompts", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "hs8-record-"));
    const path = join(home, "crow.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: home });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "Inspect the map" }] }, { turnStart: true });
        await store.appendQueuedPrompt("next", { content: "Check the sails" });
        expect(await store.repairCrashedTurn({ workerExited: true })).toBe(true);

        const repaired = await readFile(path, "utf8");
        expect(repaired.split(WORKER_EXIT_TURN_MESSAGE)).toHaveLength(2);
        const reopened = await SessionStore.open(path);
        expect((await readSessionTurnState(path)).turnOpen).toBe(false);
        expect(reopened.unsentPrompts()).toEqual([{ content: "Inspect the map" }, { content: "Check the sails" }]);
        expect(reopened.queuedPrompts()).toEqual([]);
        expect(projectTranscript(reopened.messages())).toEqual([
            { kind: "user", text: "Inspect the map" },
            { kind: "error", outcome: "error", detail: WORKER_EXIT_TURN_MESSAGE },
        ]);
        expect(reopened.messages().at(-1)).not.toHaveProperty("stopCause");
        expect(await reopened.repairCrashedTurn({ workerExited: true })).toBe(false);
        expect(await readFile(path, "utf8")).toBe(repaired);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("@core unexpected host loss annotates worker repair and preserves tool and queued repair", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "hs8-host-lost-"));
    const path = join(home, "crow.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: home });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "Inspect the map" }] }, { turnStart: true });
        await store.appendMessage({
            role: "assistant",
            content: [{ type: "tool_call", id: "read-1", name: "read", input: {} }],
            source: { provider: "test", api: "test", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        });
        await store.appendQueuedPrompt("next", { content: "Check the sails" });
        prepareWorkerExit(store, "host_stopped_unexpectedly");
        await store.appendMessage({
            role: "assistant", content: [],
            source: { provider: "test", api: "test", model: "test" },
            usage: emptyUsage(), stopReason: "error", errorMessage: "worker exit",
        });

        const reopened = await SessionStore.open(path);
        expect(reopened.messages()).toMatchObject([
            { role: "user" },
            { role: "assistant", stopReason: "tool_use" },
            { role: "tool_result", toolCallId: "read-1", isError: true },
            { role: "assistant", stopReason: "error", errorMessage: WORKER_EXIT_TURN_MESSAGE,
                stopCause: "host_stopped_unexpectedly" },
        ]);
        expect(reopened.unsentPrompts()).toEqual([{ content: "Check the sails" }]);
        expect(reopened.queuedPrompts()).toEqual([]);
        expect(await reopened.repairCrashedTurn({ workerExited: true })).toBe(false);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
