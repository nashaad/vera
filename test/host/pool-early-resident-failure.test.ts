import { expect } from "bun:test";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { runAttachedStdioBridge } from "../../clients/stdio/ndjson-bridge.ts";
import { CLIENT_CAPABILITIES } from "../../src/host/capabilities.ts";
import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { stopResidentHostWhenIdle } from "../../src/host/force-stop.ts";
import { forceStopPool } from "../../src/host/pool/force-stop-pool.ts";
import { stopWorkerProcess } from "../../src/host/pool/stop-worker.ts";
import { readRecordedWorkers, type RecordedWorker } from "../../src/host/pool/worker-records.ts";
import { processIsAlive } from "../../src/host/process-identity.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { attachReconnectingAgent } from "../../src/host/reconnecting-agent-client.ts";

socketAndLoopbackTest("a pooled resident failure reaches stdio and records its original stack", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/pool-failure-");
    const web = join(home, "web");
    await mkdir(web);
    for (const name of ["index.html", "main.js", "styles.css"]) await writeFile(join(web, name), "");
    let requests = 0;
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch() { requests += 1; return new Response("unexpected request", { status: 500 }); },
    });
    await writeFile(join(home, "config.json"), JSON.stringify({
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
    }));
    const child = spawn(process.execPath, [join(import.meta.dir, "fixtures", "pool-stop-host.ts")], {
        cwd: process.cwd(),
        env: { ...process.env, VERA_HOME: home, VERA_DEV_INSTANCE: "stopfix dev", HS9_STOP_MODE: "pool", STOPFIX_FAIL_SESSION: "1" },
        stdio: "ignore",
    });
    const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
    const socketPath = join(home, "runtime", "host.sock");
    let workers: readonly RecordedWorker[] = [];
    try {
        const deadline = Date.now() + 15_000;
        let buildId: string | undefined;
        while (true) {
            if (child.exitCode !== null || child.signalCode !== null) throw new Error("Pool host exited during startup");
            const identity = await requestHostIdentity(socketPath).catch(() => undefined);
            if (identity?.workers_ready === 3 && existsSync(join(home, "runtime", "host.json"))) {
                buildId = identity.build_id;
                break;
            }
            if (Date.now() >= deadline) throw new Error("Pool host did not start");
            await Bun.sleep(25);
        }
        if (buildId === undefined) throw new Error("Pool host did not report its build");
        workers = await readRecordedWorkers(home);
        const created = await createAgentThroughHost(socketPath, home);
        const client = await attachReconnectingAgent({
            socketPath: () => socketPath,
            agentId: created.id,
            buildId,
            requestedCapabilities: CLIENT_CAPABILITIES,
            ...(created.location === undefined ? {} : { initialLocation: created.location }),
        });
        const input = new Readable({ read() {} });
        const frames: Record<string, unknown>[] = [];
        let backgrounds = 0;
        const terminal = Promise.withResolvers<void>();
        const bridge = runAttachedStdioBridge(input, {
            write(text) {
                const frame = JSON.parse(text) as Record<string, unknown>;
                if (frame.type === "background_agents") backgrounds += 1;
                if (frames.length < 100) frames.push(frame);
                if (frame.type === "agent_failed") terminal.resolve();
            },
        }, client).catch(() => {});
        try {
            input.push('{"type":"prompt","content":"Chart a course"}\n');
            await Promise.race([terminal.promise, Bun.sleep(5_000)]);
            await Bun.sleep(250);
            expect(frames.filter((frame) => frame.type === "agent_failed")).toMatchObject([{
                type: "agent_failed", detail: "Injected pool context failure",
            }]);
            expect(backgrounds).toBeLessThan(10);
            expect(requests).toBe(0);
            expect(await readFile(join(home, "events", `${created.id}.jsonl`), "utf8"))
                .toContain('"type":"model_request"');
            const log = (await readFile(join(home, "runtime", "logs", "host.jsonl"), "utf8"))
                .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
                .filter((entry) => entry.level === "error" && entry.message === "Injected pool context failure");
            expect(log).toHaveLength(1);
            expect(log[0]?.stack).toContain("failing-session-worker.ts");
        } finally {
            input.push(null);
            client.close();
            await bridge;
        }
        expect((await stopResidentHostWhenIdle({ home, lockPath: join(home, "runtime", "host.json") }))?.endedBy).toBe("stopped");
        expect(await exited).toBe(0);
    } finally {
        const records = [...workers, ...await readRecordedWorkers(home)];
        try { await forceStopPool(home); } catch {}
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM");
            const stopped = await Promise.race([exited.then(() => true), Bun.sleep(2_500).then(() => false)]);
            if (!stopped) child.kill("SIGKILL");
        }
        await exited;
        records.push(...await readRecordedWorkers(home));
        for (const record of records) await stopWorkerProcess(record);
        stub.stop(true);
        expect(records.map((record) => record.pid).filter(processIsAlive)).toEqual([]);
        if (child.pid === undefined || !processIsAlive(child.pid)) await rm(home, { recursive: true, force: true });
    }
}, 30_000);
