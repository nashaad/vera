import { Database } from "bun:sqlite";
import { socketTest } from "../support/socket-probe.ts";
import { expect } from "bun:test";
import { mkdirSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";

import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { processCommandLine, processStartedAt } from "../../src/host/process-identity.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { runScheduleOperationThroughHost } from "../../src/host/schedule-client.ts";
import { defaultSchedulePath } from "../../src/scheduler/store.ts";
import { defaultInboxPath, Inbox } from "../../src/store/inbox.ts";
import { startScheduleWakeProvider } from "../support/schedule-wake-provider.ts";

interface PoolInfo {
    readonly pid: number;
    readonly workers: readonly number[];
    readonly annexPid?: number;
    readonly socket: string;
}

socketTest("an entry due while the host is gone wakes the adopted session once", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "h8b-inbox-"));
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    const stub = startScheduleWakeProvider(true);
    const config = {
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        inbox: { admit: ["schedule"] },
        providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
    } as const;
    await writeFile(join(home, "config.json"), JSON.stringify(config));
    const child = Bun.spawn([process.execPath, "test/host/fixtures/pool-adoption-host.ts", "1", "15000"], {
        cwd: process.cwd(), env: { ...process.env, VERA_HOME: home }, stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const started = new Map<number, { startedAt: number; command: string }>();
    let info: PoolInfo | undefined;
    let host: ResidentHost | undefined;
    let client: AttachedAgentClient | undefined;
    try {
        await waitFor(() => existsSync(join(home, "ready.json")) || child.exitCode !== null, "pool startup");
        if (!existsSync(join(home, "ready.json"))) throw new Error(`Pool host failed: ${await stderr}`);
        info = JSON.parse(await readFile(join(home, "ready.json"), "utf8")) as PoolInfo;
        for (const pid of [...info.workers, ...(info.annexPid === undefined ? [] : [info.annexPid])]) {
            const startedAt = processStartedAt(pid);
            const command = processCommandLine(pid);
            if (startedAt === undefined || command === undefined) throw new Error(`Could not inspect process ${pid}`);
            started.set(pid, { startedAt, command });
        }
        const agent = await createAgentThroughHost(info.socket, home);
        client = await attachAgent({ socketPath: agent.location!.socket_path, agentId: agent.id });
        expect((await client.receive()).type).toBe("history");
        const later = new Date(Date.now() + 12 * 60 * 60 * 1_000);
        await runScheduleOperationThroughHost(info.socket, {
            action: "add", id: "gap", cron: `${later.getUTCMinutes()} ${later.getUTCHours()} * * *`, timezone: "UTC",
            address: agent.id, payload: { text: "Check the map." },
        });
        const due = Date.now() + 1_500;
        const database = new Database(defaultSchedulePath(home));
        try {
            database.query("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(new Date(due).toISOString(), "gap");
        } finally { database.close(); }
        child.kill("SIGKILL");
        await child.exited;
        expect(Date.now()).toBeLessThan(due);
        await Bun.sleep(Math.max(0, due + 100 - Date.now()));
        expect(alive(info.workers[0]!)).toBe(true);
        host = await startResidentHost({ home, config, webRoot, skipStartupDiscovery: true });
        await waitForTurn(client);
        const inbox = Inbox.open(defaultInboxPath(home));
        try {
            const consumer = { nodeId: hostname(), label: agent.id };
            expect(inbox.offsetOf(consumer)).toBe(1);
            expect(inbox.unreadStats(consumer, { limit: 10, addresses: [agent.id] }).count).toBe(0);
        } finally { inbox.close(); }
        expect((await runScheduleOperationThroughHost(host.server.socketPath, { action: "show", id: "gap" })).run_count).toBe(1);
        const repeated = await Promise.race([waitForTurn(client).then(() => true), Bun.sleep(1_000).then(() => false)]);
        expect(repeated).toBe(false);
        expect(stub.requests).toBe(2);
    } finally {
        client?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await child.exited;
        for (const [pid, recorded] of started) {
            if (alive(pid)) {
                const startedAt = processStartedAt(pid);
                if (startedAt === undefined || Math.abs(startedAt - recorded.startedAt) > 2_000
                    || processCommandLine(pid) !== recorded.command) throw new Error(`Process ${pid} no longer matches`);
                try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
            }
            await waitFor(() => !alive(pid), `process ${pid} exit`);
        }
        if (annexPid !== undefined) await waitFor(() => !alive(annexPid), "replacement annex exit");
        stub.close();
        await stderr;
        await rm(home, { recursive: true, force: true });
    }
}, 40_000);

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await Bun.sleep(10);
    }
}

async function waitForTurn(client: AttachedAgentClient): Promise<void> {
    while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
}
