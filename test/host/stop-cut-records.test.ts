import { expect } from "bun:test";
import { socketTest } from "../support/socket-probe.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachAgent } from "../../src/host/attached-client.ts";
import { cutStopWaitThroughHost } from "../../src/host/stop-wait-cut-client.ts";
import { requestHostStop, type HostStopResult } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { recoverCrashedTurns } from "../../src/host/restart-scan.ts";
import {
    defaultRestartRecordPath,
    listRestartRecords,
} from "../../src/store/restart-records.ts";
import { readSessionTurnState } from "../../src/store/session-store.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

/**
 * A stop wait that cuts a running turn writes one "stop" record to the home's
 * record file. The cut turn ends aborted, so the next startup scan records nothing.
 */

const config = {
    schema_version: 1,
    provider: "openrouter",
    model: "faux/test",
    approval_mode: "full_access",
} as const;

socketTest(
    "a stop wait cut writes a stop record under the home and the next scan does not record the cut turn",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-stop-cut-record-"));
        const socketPath = join(root, "host.sock");
        const sessionDirectory = join(root, "sessions");
        const eventLogDirectory = join(root, "events");
        const startedAt = new Date(Date.now() - 60_000);
        const host = await startResidentHost({
            home: root,
            config,
            createAdapter: () => new FauxAdapter(
                [textResponse("x".repeat(600))],
                { chunkSize: 1, delayMs: 20 },
            ),
            blockedDirectory: join(root, "blocked"),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory,
            eventLogDirectory,
        });
        const eventLog = join(eventLogDirectory, "cutter.jsonl");
        const recordPath = defaultRestartRecordPath(root);
        let announced = false;
        try {
            await host.registry.create({ id: "cutter", workspace: root });
            const client = await attachAgent({ socketPath, agentId: "cutter" });
            expect((await client.receive()).type).toBe("history");
            await client.send({ type: "prompt", content: "start a long turn" });
            await waitFor(async () => (await countEvents(eventLog, "model_request")) === 1);

            const stopping = requestHostStop(socketPath, host.server.identity, () => {
                announced = true;
            });
            await waitFor(async () => announced);

            const cut = await cutStopWaitThroughHost(socketPath);
            expect(cut).toEqual({ type: "cut_stop_wait_done", cut: ["cutter"], failed: [] });
            const outcome: HostStopResult = await stopping;
            expect(outcome).toEqual({ type: "stopped" });
            await client.close();

            const records = listRestartRecords(recordPath);
            expect(records).toHaveLength(1);
            expect(records[0]).toEqual({
                session_id: "cutter",
                cause: "stop",
                at: expect.any(String),
            });
            expect(Number.isNaN(Date.parse(records[0]!.at))).toBe(false);

            const sessionPath = join(sessionDirectory, "cutter.jsonl");
            expect((await readSessionTurnState(sessionPath)).turnOpen).toBe(false);

            const stalePath = join(root, "stale-host.json");
            await writeFile(stalePath, `${JSON.stringify({
                schema_version: 3,
                pid: 424242,
                started_at: startedAt.toISOString(),
                socket_path: socketPath,
                build_id: "build-a",
            }, null, 2)}\n`);
            const scan = await recoverCrashedTurns({
                lockPath: stalePath,
                sessionDirectory,
                recordPath,
                isProcessAlive: () => false,
            });
            expect(scan.scanned).toBe(1);
            expect(scan.recorded).toEqual([]);
            expect(listRestartRecords(recordPath)).toHaveLength(1);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
    20_000,
);

function textResponse(body: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: body }],
        source: { provider: "faux", api: "scripted", model: "faux/test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for the host");
        await Bun.sleep(25);
    }
}

async function countEvents(path: string, type: string): Promise<number> {
    let contents: string;
    try {
        contents = await readFile(path, "utf8");
    } catch {
        return 0;
    }
    return contents.split("\n").filter((line) => line.includes(`"type":"${type}"`)).length;
}
