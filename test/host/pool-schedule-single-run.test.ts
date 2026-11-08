import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname } from "node:os";

import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { runScheduleOperationThroughHost } from "../../src/host/schedule-client.ts";
import { defaultSchedulePath } from "../../src/scheduler/store.ts";
import { defaultInboxPath, Inbox } from "../../src/store/inbox.ts";
import { startScheduleWakeProvider } from "../support/schedule-wake-provider.ts";

test("a single host acknowledges a schedule read during its wake turn", async () => {
    await checkScheduleReconnect(false, true);
}, 30_000);

test("a worker acknowledges a schedule read during its wake turn", async () => {
    await checkScheduleReconnect(true, true);
}, 30_000);

test("existing behavior: a single host reasks for an unread schedule after reconnect", async () => {
    await checkScheduleReconnect(false, false);
}, 30_000);

test("existing behavior: a worker reasks for an unread schedule after reconnect", async () => {
    await checkScheduleReconnect(true, false);
}, 30_000);

async function checkScheduleReconnect(processWorker: boolean, readInbox: boolean): Promise<void> {
    const home = await mkdtemp("/private/tmp/vera-dev/h7-single-");
    const stub = startScheduleWakeProvider(readInbox);
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let client: AttachedAgentClient | undefined;
    let workerPid: number | undefined;
    try {
        host = await startResidentHost({
            home,
            ...(processWorker ? { processWorker: true } : {}),
            skipStartupDiscovery: true,
            config: {
                schema_version: 1,
                provider: "stub",
                model: "stub-model",
                approval_mode: "auto",
                curated_models_url: "",
                inbox: { admit: ["schedule"] },
                providers: {
                    stub: {
                        protocol: "openai-chat",
                        base_url: `http://127.0.0.1:${stub.port}/v1`,
                        credential: "none",
                    },
                },
            },
        });
        const socket = host.server.socketPath;
        const agent = await createAgentThroughHost(socket, home);
        const sessionSocket = processWorker ? agent.location!.socket_path : socket;
        const sessionPid = (await requestHostIdentity(sessionSocket))!.pid;
        if (processWorker) {
            expect(agent.location?.worker_id).toBe("w0");
            workerPid = sessionPid;
            expect(workerPid).not.toBe(process.pid);
        } else {
            expect(sessionPid).toBe(process.pid);
        }
        client = await attachAgent({ socketPath: sessionSocket, agentId: agent.id });
        expect((await client.receive()).type).toBe("history");

        const later = new Date(Date.now() + 12 * 60 * 60 * 1_000);
        await runScheduleOperationThroughHost(socket, {
            action: "add", id: "crow", cron: `${later.getUTCMinutes()} ${later.getUTCHours()} * * *`, timezone: "UTC",
            address: agent.id, payload: { text: "Check the map." },
        });
        const database = new Database(defaultSchedulePath(home));
        try {
            database.query("UPDATE schedules SET next_run_at = ? WHERE id = ?")
                .run(new Date(Date.now() + 500).toISOString(), "crow");
        } finally {
            database.close();
        }
        await runScheduleOperationThroughHost(socket, { action: "show", id: "crow" });
        await waitForTurn(client);
        expect(stub.requests).toBe(readInbox ? 2 : 1);
        const inbox = Inbox.open(defaultInboxPath(home));
        let offset: number | null;
        let unread: number;
        try {
            const consumer = { nodeId: hostname(), label: agent.id };
            offset = inbox.offsetOf(consumer);
            unread = inbox.unreadStats(consumer, { limit: 10, addresses: [agent.id] }).count;
        } finally {
            inbox.close();
        }
        await client.detach();
        client.close();
        client = await attachAgent({ socketPath: sessionSocket, agentId: agent.id });
        expect((await client.receive()).type).toBe("history");
        const secondTurn = await Promise.race([
            waitForTurn(client).then(() => true),
            Bun.sleep(1_500).then(() => false),
        ]);

        const schedule = await runScheduleOperationThroughHost(socket, { action: "show", id: "crow" });
        expect(schedule.run_count).toBe(1);
        expect({ offset, unread, requests: stub.requests, secondTurn }).toEqual(readInbox
            ? { offset: 1, unread: 0, requests: 2, secondTurn: false }
            : { offset: 0, unread: 1, requests: 2, secondTurn: true });
    } finally {
        client?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        stub.close();
        try {
            if (workerPid !== undefined) expect(() => process.kill(workerPid!, 0)).toThrow();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}

async function waitForTurn(client: AttachedAgentClient): Promise<void> {
    while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
}
