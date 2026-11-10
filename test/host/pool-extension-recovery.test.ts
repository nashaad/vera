import { tmpdir } from "node:os";
import { expect, spyOn } from "bun:test";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachReconnectingAgent } from "../../src/host/reconnecting-agent-client.ts";
import type { AttachedAgentClient } from "../../src/host/attached-client.ts";
import * as supervisor from "../../src/host/pool/supervisor.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";

const MCP = fileURLToPath(new URL("../../extensions/mcp", import.meta.url));
const SERVER = fileURLToPath(new URL("../extensions/fixtures/mcp-reconnect-server.ts", import.meta.url));

socketAndLoopbackTest("a host MCP server and its commands survive worker replacement", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "h8m-"));
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    const stub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("not found", { status: 404 }) });
    const pids = new Set<number>();
    const start = supervisor.startSessionWorkerSupervisor;
    const probe = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation((options) => start({
        ...options, onSpawn(pid) { pids.add(pid); options.onSpawn?.(pid); },
    }));
    let host: ResidentHost | undefined;
    let client: AttachedAgentClient | undefined;
    try {
        host = await startResidentHost({
            home, webRoot, processWorker: true, processWorkerCount: 2, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
                extensions: [{ path: MCP, enabled: true, config: { servers: {
                    fixture: { command: [process.execPath, SERVER], env: { MCP_RECONNECT_FIXTURE: home } },
                } } }],
            },
        });
        if (host.annexPid !== undefined) pids.add(host.annexPid);
        const starts = () => readFileSync(join(home, "processes.log"), "utf8").split("\n").filter((line) => line.startsWith("start "));
        expect(starts()).toHaveLength(1);
        const mcpPid = Number(starts()[0]!.slice(6));
        pids.add(mcpPid);
        const socket = host.server.socketPath;
        const session = await createAgentThroughHost(socket, home);
        const other = await createAgentThroughHost(socket, home);
        client = await attachReconnectingAgent({ socketPath: () => socket, agentId: session.id, buildId: host.buildId, initialLocation: session.location });
        expect((await client.receive()).type).toBe("history");
        expect((await client.runExtensionCommand!("mcp-fixture-greet", "")).body).toEqual({ kind: "text", text: String(mcpPid) });
        const oldPid = (await requestHostIdentity(session.location!.socket_path))!.pid;
        const otherPid = (await requestHostIdentity(other.location!.socket_path))!.pid;
        process.kill(oldPid, "SIGKILL");
        client.close();
        const index = Number(session.location!.worker_id.slice(1));
        const deadline = Date.now() + 10_000;
        while (host.health.workers?.[index]?.state !== "replaced") {
            if (Date.now() >= deadline) throw new Error("Worker was not replaced");
            await Bun.sleep(20);
        }
        client = await attachReconnectingAgent({ socketPath: () => socket, agentId: session.id, buildId: host.buildId });
        expect((await client.receive()).type).toBe("history");
        expect((await client.runExtensionCommand!("mcp-fixture-greet", "")).body).toEqual({ kind: "text", text: String(mcpPid) });
        expect(starts()).toHaveLength(1);
        expect((await requestHostIdentity(other.location!.socket_path))?.pid).toBe(otherPid);
        expect(alive(mcpPid)).toBe(true);
    } finally {
        client?.close();
        await host?.close();
        stub.stop(true);
        probe.mockRestore();
        try {
            const deadline = Date.now() + 5_000;
            while ([...pids].some(alive) && Date.now() < deadline) await Bun.sleep(10);
            expect([...pids].filter(alive)).toEqual([]);
        } finally { await rm(home, { recursive: true, force: true }); }
    }
}, 30_000);

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}
