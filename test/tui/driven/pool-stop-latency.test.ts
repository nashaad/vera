import { tmpdir } from "node:os";
import { expect } from "bun:test";
import { socketAndLoopbackTest } from "../../support/socket-probe.ts";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAgentThroughHost } from "../../../src/host/agent-start-client.ts";
import { forceStopPool } from "../../../src/host/pool/force-stop-pool.ts";
import { stopWorkerProcess } from "../../../src/host/pool/stop-worker.ts";
import { readRecordedWorkers } from "../../../src/host/pool/worker-records.ts";
import { processIsAlive } from "../../../src/host/process-identity.ts";
import { requestHostIdentity } from "../../../src/host/protocol.ts";
import { attachReconnectingAgent } from "../../../src/host/reconnecting-agent-client.ts";
import { startTuiTestSession, type TuiTestSession } from "../../support/tui-harness.ts";

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!await check()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await Bun.sleep(25);
    }
}

for (const force of [false, true]) {
    socketAndLoopbackTest(`a pooled TUI shows host stopped promptly after a ${force ? "forced" : "waiting"} stop`, async () => {
        mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
        const root = await mkdtemp(join(tmpdir(), "vera-dev", "pool-stop-tui-"));
        const home = join(root, "host");
        const web = join(home, "web");
        await mkdir(web, { recursive: true });
        await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(web, name), "")));
        const gate = Promise.withResolvers<void>();
        let requests = 0;
        const stub = Bun.serve({
            hostname: "127.0.0.1", port: 0,
            async fetch(request) {
                if (!new URL(request.url).pathname.endsWith("/chat/completions")) {
                    return new Response("not found", { status: 404 });
                }
                requests += 1;
                await gate.promise;
                return new Response('data: {"id":"stub","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
                    headers: { "content-type": "text/event-stream" },
                });
            },
        });
        await writeFile(join(home, "config.json"), JSON.stringify({
            schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
            providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
        }));
        const host = spawn(process.execPath, [join(import.meta.dir, "../../host/fixtures/pool-stop-host.ts")], {
            cwd: process.cwd(),
            env: { ...process.env, VERA_HOME: home, VERA_DEV_INSTANCE: "stopfix dev", HS9_STOP_MODE: "pool" },
            stdio: "ignore",
        });
        const exited = new Promise<number | null>((resolve) => host.once("close", resolve));
        const socket = join(home, "runtime", "host.sock");
        let session: TuiTestSession | undefined;
        let client: Awaited<ReturnType<typeof attachReconnectingAgent>> | undefined;
        let workers = await readRecordedWorkers(home);
        try {
            await until(async () => {
                if (host.exitCode !== null || host.signalCode !== null) throw new Error("Pool host exited during startup");
                const identity = await requestHostIdentity(socket).catch(() => undefined);
                return identity?.workers_ready === 3 && !existsSync(`${socket}.starting`);
            }, "pool readiness");
            workers = await readRecordedWorkers(home);
            const identity = await requestHostIdentity(socket);
            if (identity?.build_id === undefined) throw new Error("Pool host build is unavailable");
            const agent = await createAgentThroughHost(socket, home);
            expect(agent.location?.worker_id).not.toBe("host");
            expect(agent.location?.socket_path).not.toBe(socket);
            client = await attachReconnectingAgent({
                socketPath: () => socket, agentId: agent.id, initialLocation: agent.location,
                buildId: identity.build_id, interactive: true, clientId: "stopfix-tui", failOnDisconnect: true,
            });
            let restarts = 0;
            session = await startTuiTestSession({
                home: join(root, "tui"), waitTimeoutMs: 2_500,
                dependencies: () => ({
                    client: client!,
                    reconnectSession: async () => { restarts += 1; throw new Error("Unexpected restart"); },
                }),
            });
            await session.waitForVisiblePane("Start a conversation with Vera");
            session.sendText("Chart a course");
            session.sendKey("Enter");
            await until(() => requests === 1, "model request");
            const command = Bun.spawn([process.execPath, "clients/cli/main.ts", "host", "stop", ...(force ? ["--force"] : []), "--yes"], {
                cwd: process.cwd(),
                env: { ...process.env, VERA_HOME: home, VERA_DEV_INSTANCE: "stopfix dev" },
                stdout: "pipe", stderr: "pipe",
            });
            const commandResult = Promise.all([
                command.exited, new Response(command.stdout).text(), new Response(command.stderr).text(),
            ]);
            if (!force) {
                await session.waitForVisiblePane("Vera is stopping.");
                session.sendKey("Escape");
                gate.resolve();
            }
            expect(await exited).toBe(0);
            const stoppedAt = performance.now();
            const pane = await session.waitForVisiblePane("host stopped · Ctrl+L restart");
            expect(performance.now() - stoppedAt).toBeLessThan(2_000);
            expect(pane).toContain("The host stopped.");
            expect(restarts).toBe(0);
            const [exitCode, , stderr] = await commandResult;
            expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
            expect(existsSync(join(home, "runtime", "host.json"))).toBe(false);
            expect(existsSync(socket)).toBe(false);
        } finally {
            gate.resolve();
            await session?.close();
            client?.close();
            const records = [...workers, ...await readRecordedWorkers(home)];
            try { await forceStopPool(home); } catch {}
            if (host.exitCode === null && host.signalCode === null) {
                host.kill("SIGTERM");
                const stopped = await Promise.race([exited.then(() => true), Bun.sleep(2_500).then(() => false)]);
                if (!stopped) host.kill("SIGKILL");
            }
            await exited;
            records.push(...await readRecordedWorkers(home));
            for (const record of records) await stopWorkerProcess(record);
            stub.stop(true);
            expect([...(host.pid === undefined ? [] : [host.pid]), ...records.map((record) => record.pid)].filter(processIsAlive)).toEqual([]);
            await rm(root, { recursive: true, force: true });
        }
    }, 40_000);
}
