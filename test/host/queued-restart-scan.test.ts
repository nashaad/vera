import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recoverCrashedTurns } from "../../src/host/restart-scan.ts";
import { emptyUsage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";

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
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "inspect" }] });
        await store.appendQueuedPrompt("next", { content: "check the sails" });
        await store.appendMessage({
            role: "assistant", content: [{ type: "text", text: "clear" }],
            source: { provider: "stub", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "stop",
        });
        const result = await recoverCrashedTurns({
            lockPath, sessionDirectory: sessions, recordPath: join(root, "restarts.jsonl"),
            isProcessAlive: () => false,
        });
        expect(result.recorded).toEqual(["crow"]);
        expect((await SessionStore.open(path)).unsentPrompts()).toEqual([{ content: "check the sails" }]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
