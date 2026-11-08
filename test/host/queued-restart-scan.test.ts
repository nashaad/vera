import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recoverCrashedTurns } from "../../src/host/restart-scan.ts";
import { emptyUsage } from "../../src/model/types.ts";
import { listRestartRecords } from "../../src/store/restart-records.ts";
import { CRASH_CUT_MESSAGE, CRASH_QUEUED_PROMPT_MESSAGE, readSessionTurnState, SessionStore } from "../../src/store/session-store.ts";

test("restart scan recovers queued prompts after a completed reply", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-queue-scan-"));
    const sessions = join(root, "sessions");
    const path = join(sessions, "crow.jsonl");
    const lockPath = join(root, "host.json");
    try {
        await mkdir(sessions);
        await writeFile(lockPath, JSON.stringify({
            schema_version: 3, pid: 424242, started_at: new Date(Date.now() - 60_000).toISOString(),
            socket_path: join(root, "host.sock"), build_id: "test",
        }));
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "inspect" }] }, { turnStart: true });
        await store.appendQueuedPrompt("next", { content: "check the sails" });
        await store.appendMessage({
            role: "assistant", content: [{ type: "text", text: "clear" }],
            source: { provider: "stub", api: "scripted", model: "test" }, usage: emptyUsage(),
            stopReason: "stop", turnTiming: { durationMs: 1, finishedAt: 1 },
        });
        expect((await readSessionTurnState(path)).turnOpen).toBe(false);
        const recordPath = join(root, "restarts.jsonl");
        const result = await recoverCrashedTurns({
            lockPath, sessionDirectory: sessions, recordPath,
            isProcessAlive: () => false,
        });
        expect(result.recorded).toEqual(["crow"]);
        const reopened = await SessionStore.open(path);
        expect(reopened.unsentPrompts()).toEqual([{ content: "check the sails" }]);
        expect(reopened.projectedHarnessMessages()).toEqual([{ afterMessage: 2, text: CRASH_QUEUED_PROMPT_MESSAGE, tone: "soft" }]);
        expect(listRestartRecords(recordPath)).toMatchObject([{ session_id: "crow", cause: "crash" }]);
        const repaired = await readFile(path, "utf8");
        expect(repaired).not.toContain(CRASH_CUT_MESSAGE);
        expect(await recoverCrashedTurns({ lockPath, sessionDirectory: sessions, recordPath, isProcessAlive: () => false }))
            .toMatchObject({ recorded: [] });
        expect(await readFile(path, "utf8")).toBe(repaired);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
