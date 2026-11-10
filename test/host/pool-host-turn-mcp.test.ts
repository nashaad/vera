import { tmpdir } from "node:os";
import { expect } from "bun:test";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";

const MCP = fileURLToPath(new URL("../../extensions/mcp", import.meta.url));
const SERVER = fileURLToPath(new URL("../extensions/fixtures/mcp-reconnect-server.ts", import.meta.url));

function running(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

socketAndLoopbackTest("a host-owned turn does not start another MCP server", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "h7bm-"));
    const webRoot = join(home, "web");
    const previous = process.env.VERA_WORKER_EXTENSIONS;
    process.env.VERA_WORKER_EXTENSIONS = "1";
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            started.resolve();
            await release.promise;
            return new Response([
                'data: {"id":"x","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"The crow found the map."},"finish_reason":"stop"}]}',
                "", "data: [DONE]", "",
            ].join("\n"), { headers: { "content-type": "text/event-stream" } });
        },
    });
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let client: AttachedAgentClient | undefined;
    const pids = new Set<number>();
    const starts = (): string[] => {
        const path = join(home, "processes.log");
        if (!existsSync(path)) return [];
        const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.startsWith("start "));
        for (const line of lines) {
            const pid = Number(line.slice(6));
            if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
        }
        return lines;
    };
    try {
        await mkdir(webRoot);
        await Promise.all([
            writeFile(join(webRoot, "index.html"), "<!doctype html><title>Vera</title>"),
            writeFile(join(webRoot, "main.js"), ""),
            writeFile(join(webRoot, "styles.css"), ""),
        ]);
        host = await startResidentHost({
            home, webRoot, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "ask", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
                extensions: [{ path: MCP, enabled: true, config: { servers: {
                    fixture: { command: [process.execPath, SERVER], env: { MCP_RECONNECT_FIXTURE: home } },
                } } }],
            },
        });
        pids.add((await requestHostIdentity(join(home, "runtime", "w0.sock")))!.pid);
        expect(host.annexPid).toBeDefined();
        pids.add(host.annexPid!);
        expect(starts()).toHaveLength(1);
        expect(pids.size).toBe(3);
        const agent = await host.registry.create({ workspace: home });
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: agent.id });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Chart the crow course" });
        await Promise.race([started.promise, Bun.sleep(15_000).then(() => { throw new Error("Provider was not reached"); })]);
        expect(host.registry.agents.get(agent.id)!.worker).toBeUndefined();
        expect(starts()).toHaveLength(1);
        release.resolve();
        let update = await client.receive(AbortSignal.timeout(10_000));
        while (update.type !== "turn_finished") update = await client.receive(AbortSignal.timeout(10_000));
        expect(update.outcome).toBeUndefined();
        expect(host.registry.agents.get(agent.id)!.worker).toBeUndefined();
        expect(starts()).toHaveLength(1);
    } finally {
        release.resolve();
        client?.close();
        if (host?.annexPid !== undefined) pids.add(host.annexPid);
        starts();
        await host?.close();
        starts();
        stub.stop(true);
        if (previous === undefined) delete process.env.VERA_WORKER_EXTENSIONS;
        else process.env.VERA_WORKER_EXTENSIONS = previous;
        const deadline = Date.now() + 5_000;
        while ([...pids].some(running) && Date.now() < deadline) await Bun.sleep(10);
        console.log(JSON.stringify({ stopped: [...pids].filter((pid) => !running(pid)), stillLive: [...pids].filter(running) }));
        expect([...pids].filter(running)).toEqual([]);
        await rm(home, { recursive: true, force: true });
    }
}, 30_000);
