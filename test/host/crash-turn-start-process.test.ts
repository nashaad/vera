import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readSessionSeed } from "../../src/host/agent-registry/helpers.ts";
import { startSeededWorker, type WorkerHandle } from "../../src/host/worker/handle.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { CRASH_CUT_MESSAGE, openSessionForRecovery, readSessionSnapshot, readSessionTurnState, SessionStore } from "../../src/store/session-store.ts";

const adapterModule = fileURLToPath(new URL("./fixtures/worker-scripted-adapter.ts", import.meta.url));
const response: AssistantMessage = {
    role: "assistant", content: [{ type: "text", text: "The map is ready." }],
    source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "stop",
};

for (const kind of ["prompt", "delivery"] as const) {
    test(`a killed worker repairs a ${kind} turn before the first model output`, async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-turn-start-kill-"));
        const path = join(root, "session.jsonl");
        const requestPath = join(root, "requests.log");
        let worker: WorkerHandle | undefined;
        try {
            const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
            if (kind === "delivery") {
                await store.recordDelivery({ id: "delivery-1", sourceAgentId: "child", content: "Found the map" });
            }
            worker = await startSeededWorker({
                store, model: "test", data: { approvalMode: "auto" },
                adapter: { module: adapterModule, options: { script: [response], delayMs: 10_000, chunkSize: 1, requestLogPath: requestPath } },
            }, readSessionSeed);
            worker.send(kind === "prompt"
                ? { type: "prompt", content: "Chart the cove" }
                : { type: "trigger_delivery_turn" });
            const deadline = Date.now() + 10_000;
            while (!existsSync(requestPath)) {
                if (Date.now() > deadline) throw new Error("Timed out waiting for the request");
                await Bun.sleep(10);
            }
            expect((await readSessionTurnState(path)).turnOpen).toBe(true);
            const records = (await readFile(path, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
            const starts = records.filter((record) => record.type === "turn_start");
            expect(starts).toHaveLength(1);
            if (kind === "delivery") expect(starts[0].deliveryId).toBe("delivery-1");
            const pid = worker.pid;
            worker.kill();
            expect(await worker.outcome).toMatchObject({ kind: "killed" });
            expect(() => process.kill(pid, 0)).toThrow();
            worker = undefined;
            await openSessionForRecovery(path);
            expect((await readSessionSnapshot(path)).harnessMessages.at(-1)?.text).toBe(CRASH_CUT_MESSAGE);
            expect((await readSessionTurnState(path)).turnOpen).toBe(false);
        } finally {
            if (worker !== undefined) {
                worker.kill();
                await worker.outcome;
            }
            await rm(root, { recursive: true, force: true });
        }
    }, 20_000);
}
