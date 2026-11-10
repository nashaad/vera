import { expect, test } from "bun:test";
import { mkdirSync, existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";

import { resumeAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { processStartedAt } from "../../src/host/process-identity.ts";
import { signalVerifiedProcess, signalVerifiedProcessGroup, type ProcessGroupIdentity } from "../../src/process-group.ts";
import { runScheduleOperationThroughHost } from "../../src/host/schedule-client.ts";
import { defaultSchedulePath, ScheduleStore } from "../../src/scheduler/store.ts";
import { defaultInboxPath, Inbox } from "../../src/store/inbox.ts";
import { defaultSessionDirectory, SessionStore } from "../../src/store/session-store.ts";
import { startScheduleWakeProvider } from "../support/schedule-wake-provider.ts";

interface PoolHostInfo {
    readonly pid: number;
    readonly workerPid: number;
    readonly annexPid?: number;
    readonly socket: string;
}

test("a schedule due at startup wakes its worker once", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "h7-start-"));
    const stub = startScheduleWakeProvider(true);
    const id = "startup-crow";
    const sessionPath = join(defaultSessionDirectory(home), `${id}.jsonl`);
    const consumer = { nodeId: hostname(), label: id };
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let client: AttachedAgentClient | undefined;
    let info: PoolHostInfo | undefined;
    let stderr: Promise<string> | undefined;
    let hostStartedAt = "";
    const children: ProcessGroupIdentity[] = [];
    try {
        await SessionStore.create(sessionPath, { sessionId: id, cwd: home });
        const inbox = Inbox.open(defaultInboxPath(home));
        inbox.close();
        const schedules = ScheduleStore.open(defaultSchedulePath(home));
        const now = new Date();
        const later = new Date(now.getTime() + 12 * 60 * 60 * 1_000);
        schedules.create({
            id: "startup", cron: `${later.getUTCMinutes()} ${later.getUTCHours()} * * *`,
            timezone: "UTC", address: id, payload: JSON.stringify({ text: "Check the map." }),
            nextRunAt: new Date(now.getTime() - 1_000).toISOString(), now: now.toISOString(),
        });
        schedules.close();
        await writeFile(join(home, "config.json"), JSON.stringify({
            schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto",
            curated_models_url: "", inbox: { admit: ["schedule"] },
            providers: {
                stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" },
            },
        }));
        hostStartedAt = new Date().toISOString();
        const spawned = Bun.spawn([process.execPath, "test/host/fixtures/pool-crash-host.ts"], {
            cwd: process.cwd(), env: { ...process.env, VERA_HOME: home }, detached: true,
            stdout: "ignore", stderr: "pipe",
        });
        child = spawned;
        stderr = new Response(spawned.stderr).text();
        const readyPath = join(home, "ready.json");
        await waitFor(() => existsSync(readyPath) || child!.exitCode !== null, "pool startup");
        if (!existsSync(readyPath)) throw new Error(`Pool host exited: ${await stderr}`);
        info = JSON.parse(await readFile(readyPath, "utf8")) as PoolHostInfo;
        for (const pid of [info.workerPid, info.annexPid]) {
            if (pid === undefined) continue;
            const startedAt = processStartedAt(pid);
            children.push({ pid, started_at: startedAt === undefined ? "" : new Date(startedAt).toISOString() });
        }
        expect(info.pid).toBe(child.pid);
        expect(info.workerPid).not.toBe(info.pid);
        expect((await listAgentsThroughHost(info.socket)).find((agent) => agent.id === id))
            .toMatchObject({ id, live: false });
        const held = Inbox.open(defaultInboxPath(home));
        try {
            expect(held.offsetOf(consumer)).toBe(0);
            expect(held.unreadStats(consumer, { limit: 10, addresses: [id] }).count).toBe(1);
        } finally {
            held.close();
        }
        expect(stub.requests).toBe(0);
        const resumed = await resumeAgentThroughHost(info.socket, sessionPath);
        expect(resumed.location?.worker_id).toBe("w0");
        client = await attachAgent({ socketPath: resumed.location!.socket_path, agentId: id });
        expect((await client.receive()).type).toBe("history");
        await waitForTurn(client);
        const reopened = Inbox.open(defaultInboxPath(home));
        try {
            expect(reopened.offsetOf(consumer)).toBe(1);
            expect(reopened.unreadStats(consumer, { limit: 10, addresses: [id] }).count).toBe(0);
        } finally {
            reopened.close();
        }
        expect((await runScheduleOperationThroughHost(info.socket, { action: "show", id: "startup" })).run_count).toBe(1);
        await client.detach();
        client.close();
        client = await attachAgent({ socketPath: resumed.location!.socket_path, agentId: id });
        expect((await client.receive()).type).toBe("history");
        const repeated = await Promise.race([
            waitForTurn(client).then(() => true),
            Bun.sleep(1_500).then(() => false),
        ]);
        expect(repeated).toBe(false);
        expect(stub.requests).toBe(2);
    } finally {
        client?.close();
        if (child !== undefined) {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
            const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(3_000).then(() => false)]);
            if (!exited) {
                const host = { pid: child.pid, started_at: hostStartedAt };
                if (signalVerifiedProcessGroup(host, "SIGKILL") !== "sent") child.kill("SIGKILL");
            }
            await child.exited;
            for (const record of children) signalVerifiedProcess(record, "SIGKILL");
            await waitFor(() => !groupAlive(child!.pid), "pool process group exit");
            await stderr;
        }
        stub.close();
        try {
            if (info !== undefined) {
                expect(() => process.kill(info!.workerPid, 0)).toThrow();
                if (info.annexPid !== undefined) expect(() => process.kill(info!.annexPid!, 0)).toThrow();
            }
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 30_000);

function groupAlive(pid: number): boolean {
    const result = Bun.spawnSync(["ps", "-axo", "pgid="], { stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) throw new Error("Could not list process groups");
    return result.stdout.toString().split("\n").some((line) => Number(line.trim()) === pid);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await Bun.sleep(20);
    }
}

async function waitForTurn(client: AttachedAgentClient): Promise<void> {
    while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
}
