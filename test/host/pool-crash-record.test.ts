import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { projectTranscript } from "../../src/engine/protocol.ts";
import { readSessionTurnState, SessionStore, WORKER_EXIT_TURN_MESSAGE } from "../../src/store/session-store.ts";

test("worker recovery records one failed turn and preserves unsent prompts", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs8-record-");
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
        expect(await reopened.repairCrashedTurn({ workerExited: true })).toBe(false);
        expect(await readFile(path, "utf8")).toBe(repaired);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
