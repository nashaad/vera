import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyUsage } from "../../src/model/types.ts";
import { RestartLedger } from "../../src/host/pool/restart-ledger.ts";
import { repairHostLostSession } from "../../src/host/pool/worker-host-loss.ts";
import { prepareWorkerExit } from "../../src/host/pool/worker-exit.ts";
import { defaultRestartRecordPath } from "../../src/store/restart-records.ts";
import { readSessionTurnState, SessionStore } from "../../src/store/session-store.ts";

test("@core host-loss close records each repaired session in the restart ledger", async () => {
    const home = await mkdtemp(join(tmpdir(), "vera-host-lost-record-"));
    try {
        const stores = await Promise.all(["cut-a", "cut-b"].map(async (sessionId) => {
            const store = await SessionStore.create(join(home, `${sessionId}.jsonl`), { sessionId, cwd: home });
            await store.appendMessage({
                role: "user",
                content: [{ type: "text", text: "Chart the crow's course." }],
            }, { turnStart: true });
            prepareWorkerExit(store, "host_stopped_unexpectedly");
            await store.appendMessage({
                role: "assistant",
                content: [{ type: "text", text: "The course is clear." }],
                source: { provider: "faux", api: "scripted", model: "test" },
                usage: emptyUsage(),
                stopReason: "stop",
            });
            expect((await readSessionTurnState(store.path)).turnOpen).toBe(false);
            expect(await store.repairCrashedTurn({
                workerExited: true,
                stopCause: "host_stopped_unexpectedly",
            })).toBe(false);
            return store;
        }));

        for (const store of stores) await repairHostLostSession(store, home);

        const records = await new RestartLedger(defaultRestartRecordPath(home)).list();
        expect(records).toHaveLength(stores.length);
        expect(records.map((record) => record.session_id).sort()).toEqual(stores.map((store) => store.header.id).sort());
        expect(records.every((record) => record.cause === "crash" && !Number.isNaN(Date.parse(record.at)))).toBe(true);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
